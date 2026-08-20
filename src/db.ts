import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApiKeyRow, LogPolicy, ModelTokenRow, RequestLogFilters, RequestLogQuery, RequestLogRow, TokenTotals } from "./contracts.js";

export const DEFAULT_LOG_POLICY: LogPolicy = {
  retentionDays: 30,
  maxRows: 100_000,
};

export const SCHEMA_VERSION = 2;

const logPolicies = new WeakMap<DatabaseSync, LogPolicy>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_digest TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  request_limit INTEGER NOT NULL,
  used_requests INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  path TEXT NOT NULL,
  model TEXT NOT NULL,
  stream INTEGER NOT NULL,
  http_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);
`;

export function openDb(dataDir: string, policy: LogPolicy = DEFAULT_LOG_POLICY): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "cursor-api.sqlite"), { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
  migrateRequestLogs(db);
  logPolicies.set(db, policy);
  pruneRequestLogs(db);
  return db;
}

export function insertApiKey(
  db: DatabaseSync,
  row: Omit<ApiKeyRow, "used_requests" | "request_limit" | "enabled"> & {
    enabled?: number;
  },
): void {
  db.prepare(
    `INSERT INTO api_keys (
      id, name, key_prefix, key_digest, enabled, request_limit, used_requests, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.key_prefix,
    row.key_digest,
    row.enabled ?? 1,
    0,
    0,
    row.created_at,
    row.updated_at,
  );
}

export function getApiKeyByDigest(db: DatabaseSync, digest: string): ApiKeyRow | undefined {
  const row = db.prepare("SELECT * FROM api_keys WHERE key_digest = ?").get(digest);
  return row ? mapApiKey(row) : undefined;
}

export function getApiKeyById(db: DatabaseSync, id: string): ApiKeyRow | undefined {
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id);
  return row ? mapApiKey(row) : undefined;
}

export function listApiKeys(db: DatabaseSync): ApiKeyRow[] {
  return db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all().map(mapApiKey);
}

export function disableApiKey(db: DatabaseSync, id: string): ApiKeyRow | undefined {
  return setApiKeyEnabled(db, id, 0);
}

export function enableApiKey(db: DatabaseSync, id: string): ApiKeyRow | undefined {
  return setApiKeyEnabled(db, id, 1);
}

function setApiKeyEnabled(db: DatabaseSync, id: string, enabled: 0 | 1): ApiKeyRow | undefined {
  const existing = getApiKeyById(db, id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.prepare("UPDATE api_keys SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled, now, id);
  return getApiKeyById(db, id);
}

export function insertRequestLog(db: DatabaseSync, row: RequestLogRow): void {
  db.prepare(
    `INSERT INTO request_logs (
      id, api_key_id, path, model, stream, http_status, duration_ms,
      input_tokens, output_tokens, total_tokens, error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.api_key_id,
    row.path,
    row.model,
    row.stream,
    row.http_status,
    row.duration_ms,
    row.input_tokens,
    row.output_tokens,
    row.total_tokens,
    row.error_code,
    row.created_at,
  );
  pruneRequestLogs(db);
}

export function listRequestLogs(db: DatabaseSync, query: RequestLogQuery): {
  logs: RequestLogRow[];
  total: number;
} {
  const { sql, params } = logWhere(query);
  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM request_logs l ${sql}`).get(...params);
  const logs = db
    .prepare(
      `SELECT l.*, k.name AS key_name, k.key_prefix AS key_prefix
       FROM request_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ${sql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset)
    .map(mapRequestLog);
  return { logs, total: totalRow ? asNumber(totalRow.count) : 0 };
}

export function listRequestLogFilters(db: DatabaseSync): RequestLogFilters {
  const models = db
    .prepare("SELECT DISTINCT model FROM request_logs ORDER BY model ASC")
    .all()
    .map((row) => asString(row.model));
  const keys = db
    .prepare(
      `SELECT DISTINCT l.api_key_id AS id, k.name AS name, k.key_prefix AS key_prefix
       FROM request_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ORDER BY k.name ASC, l.api_key_id ASC`,
    )
    .all()
    .map((row) => ({
      id: asString(row.id),
      name: asNullableString(row.name),
      key_prefix: asNullableString(row.key_prefix),
    }));
  const statuses = db
    .prepare("SELECT DISTINCT http_status FROM request_logs ORDER BY http_status ASC")
    .all()
    .map((row) => asNumber(row.http_status));
  return { models, keys, statuses };
}

function logWhere(query: RequestLogQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (query.model !== undefined) {
    clauses.push("l.model = ?");
    params.push(query.model);
  }
  if (query.api_key_id !== undefined) {
    clauses.push("l.api_key_id = ?");
    params.push(query.api_key_id);
  }
  if (query.http_status !== undefined) {
    clauses.push("l.http_status = ?");
    params.push(query.http_status);
  }
  if (query.from !== undefined) {
    clauses.push("l.created_at >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("l.created_at <= ?");
    params.push(query.to);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function pruneRequestLogs(db: DatabaseSync): number {
  const policy = logPolicies.get(db) ?? DEFAULT_LOG_POLICY;
  const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let removed = asNumber(
    db.prepare("DELETE FROM request_logs WHERE created_at < ?").run(cutoff).changes,
  );
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM request_logs").get();
  const count = countRow ? asNumber(countRow.count) : 0;
  if (count > policy.maxRows) {
    const excess = count - policy.maxRows;
    removed += asNumber(
      db
        .prepare(
          `DELETE FROM request_logs
           WHERE id IN (
             SELECT id FROM request_logs ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(excess).changes,
    );
  }
  return removed;
}

export function requestTokenStats(db: DatabaseSync): {
  retention_days: number;
  max_rows: number;
  totals: TokenTotals;
  by_model: ModelTokenRow[];
} {
  const policy = logPolicies.get(db) ?? DEFAULT_LOG_POLICY;
  const totals = mapTokenTotals(
    db
      .prepare(
        `SELECT
           COUNT(*) AS request_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_usage_count
         FROM request_logs`,
      )
      .get(),
  );
  const by_model = db
    .prepare(
      `SELECT
         model,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_usage_count
       FROM request_logs
       GROUP BY model
       ORDER BY total_tokens DESC, request_count DESC, model ASC`,
    )
    .all()
    .map((row) => ({
      model: asString(row.model),
      ...mapTokenTotals(row),
    }));
  return { retention_days: policy.retentionDays, max_rows: policy.maxRows, totals, by_model };
}

export function requestStats(db: DatabaseSync): {
  by_key: Array<{ api_key_id: string; count: number }>;
  by_model: Array<{ model: string; count: number }>;
  by_status: Array<{ http_status: number; count: number }>;
  tokens: ReturnType<typeof requestTokenStats>;
} {
  const by_key = db
    .prepare("SELECT api_key_id, COUNT(*) AS count FROM request_logs GROUP BY api_key_id")
    .all()
    .map((row) => ({
      api_key_id: asString(row.api_key_id),
      count: asNumber(row.count),
    }));
  const by_model = db
    .prepare("SELECT model, COUNT(*) AS count FROM request_logs GROUP BY model")
    .all()
    .map((row) => ({
      model: asString(row.model),
      count: asNumber(row.count),
    }));
  const by_status = db
    .prepare("SELECT http_status, COUNT(*) AS count FROM request_logs GROUP BY http_status")
    .all()
    .map((row) => ({
      http_status: asNumber(row.http_status),
      count: asNumber(row.count),
    }));
  return { by_key, by_model, by_status, tokens: requestTokenStats(db) };
}

function migrateRequestLogs(db: DatabaseSync): void {
  const columns = new Set(
    db.prepare("PRAGMA table_info(request_logs)").all().map((row) => asString(row.name)),
  );
  if (!columns.has("path")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN path TEXT NOT NULL DEFAULT '/v1/chat/completions'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model)");
}

function mapApiKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: asString(row.id),
    name: asString(row.name),
    key_prefix: asString(row.key_prefix),
    key_digest: asString(row.key_digest),
    enabled: asNumber(row.enabled),
    request_limit: asNumber(row.request_limit),
    used_requests: asNumber(row.used_requests),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function mapRequestLog(row: Record<string, unknown>): RequestLogRow {
  return {
    id: asString(row.id),
    api_key_id: asString(row.api_key_id),
    path: asNullableString(row.path) ?? "/v1/chat/completions",
    model: asString(row.model),
    stream: asNumber(row.stream),
    http_status: asNumber(row.http_status),
    duration_ms: asNumber(row.duration_ms),
    input_tokens: asNullableNumber(row.input_tokens),
    output_tokens: asNullableNumber(row.output_tokens),
    total_tokens: asNullableNumber(row.total_tokens),
    error_code: asNullableString(row.error_code),
    created_at: asString(row.created_at),
    key_name: asNullableString(row.key_name),
    key_prefix: asNullableString(row.key_prefix),
  };
}

function mapTokenTotals(row: Record<string, unknown> | undefined): TokenTotals {
  if (!row) {
    return {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unknown_usage_count: 0,
    };
  }
  return {
    request_count: asNumber(row.request_count),
    input_tokens: asNumber(row.input_tokens),
    output_tokens: asNumber(row.output_tokens),
    total_tokens: asNumber(row.total_tokens),
    unknown_usage_count: asNumber(row.unknown_usage_count),
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected string, got ${typeof value}`);
  }
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected number, got ${typeof value}`);
  }
  return value;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value);
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}
