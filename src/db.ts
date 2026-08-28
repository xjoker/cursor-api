import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ApiKeyRow,
  KeyTokenRow,
  LogPolicy,
  ModelTokenRow,
  RequestLogFilters,
  RequestLogQuery,
  RequestLogRow,
  SystemLogQuery,
  SystemLogRow,
  TokenTotals,
} from "./contracts.js";

export const DEFAULT_LOG_POLICY: LogPolicy = {
  retentionDays: 7,
  maxRows: 100_000,
  maxDetailBytes: 268_435_456,
};

/** Per-row cap for the client-controlled `model` column (UTF-8 bytes). */
export const MAX_LOG_MODEL_BYTES = 256;

export const SCHEMA_VERSION = 6;

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
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  upstream_ms INTEGER,
  gateway_ms INTEGER,
  request_detail TEXT,
  response_detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);
CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  fields TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
CREATE TABLE IF NOT EXISTS conversations (
  api_key_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, conversation_id)
);
`;

export function openDb(dataDir: string, policy: LogPolicy = DEFAULT_LOG_POLICY): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "cursor-api.sqlite");
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
  migrateRequestLogs(db);
  migrateSystemLogs(db);
  migrateConversations(db);
  logPolicies.set(db, policy);
  pruneRequestLogs(db);
  pruneSystemLogs(db);
  chmodOwnerOnly(dbPath);
  chmodOwnerOnly(`${dbPath}-wal`);
  chmodOwnerOnly(`${dbPath}-shm`);
  return db;
}

function limitUtf8(text: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buf.subarray(0, cut).toString("utf8");
}

function chmodOwnerOnly(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    // 部分文件系统/挂载不支持 chmod
  }
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

export function deleteApiKey(db: DatabaseSync, id: string): ApiKeyRow | undefined {
  const existing = getApiKeyById(db, id);
  if (!existing) return undefined;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.prepare("DELETE FROM conversations WHERE api_key_id = ?").run(id);
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  return existing;
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
      input_tokens, output_tokens, total_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens,
      error_code, created_at,
      upstream_ms, gateway_ms, request_detail, response_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.api_key_id,
    row.path,
    limitUtf8(row.model, MAX_LOG_MODEL_BYTES),
    row.stream,
    row.http_status,
    row.duration_ms,
    row.input_tokens,
    row.output_tokens,
    row.total_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.reasoning_tokens,
    row.error_code,
    row.created_at,
    row.upstream_ms,
    row.gateway_ms,
    row.request_detail,
    row.response_detail,
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
      `SELECT l.id, l.api_key_id, l.path, l.model, l.stream, l.http_status, l.duration_ms,
              l.input_tokens, l.output_tokens, l.total_tokens,
              l.cache_read_tokens, l.cache_write_tokens, l.reasoning_tokens,
              l.error_code, l.created_at,
              l.upstream_ms, l.gateway_ms,
              CASE WHEN l.request_detail IS NOT NULL OR l.response_detail IS NOT NULL THEN 1 ELSE 0 END AS has_detail,
              k.name AS key_name, k.key_prefix AS key_prefix
       FROM request_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ${sql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset)
    .map(mapRequestLogList);
  return { logs, total: totalRow ? asNumber(totalRow.count) : 0 };
}

export function getRequestLogById(db: DatabaseSync, id: string): RequestLogRow | undefined {
  const row = db
    .prepare(
      `SELECT l.*, k.name AS key_name, k.key_prefix AS key_prefix
       FROM request_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       WHERE l.id = ?`,
    )
    .get(id);
  return row ? mapRequestLog(row) : undefined;
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
  // Drop oldest rows until model + detail payload fits under maxDetailBytes.
  for (;;) {
    const sizeRow = db
      .prepare(
        `SELECT COALESCE(SUM(
           COALESCE(length(cast(model AS BLOB)), 0)
           + COALESCE(length(cast(request_detail AS BLOB)), 0)
           + COALESCE(length(cast(response_detail AS BLOB)), 0)
         ), 0) AS bytes FROM request_logs`,
      )
      .get();
    const bytes = sizeRow ? asNumber(sizeRow.bytes) : 0;
    if (bytes <= policy.maxDetailBytes) break;
    const deleted = asNumber(
      db
        .prepare(
          `DELETE FROM request_logs
           WHERE id IN (
             SELECT id FROM request_logs ORDER BY created_at ASC LIMIT 1
           )`,
        )
        .run().changes,
    );
    if (deleted < 1) break;
    removed += deleted;
  }
  return removed;
}

export function requestTokenStats(db: DatabaseSync): {
  retention_days: number;
  max_rows: number;
  max_detail_bytes: number;
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
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
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
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
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
  return {
    retention_days: policy.retentionDays,
    max_rows: policy.maxRows,
    max_detail_bytes: policy.maxDetailBytes,
    totals,
    by_model,
  };
}

export function requestStats(db: DatabaseSync): {
  by_key: Array<{ api_key_id: string; count: number }>;
  by_model: Array<{ model: string; count: number }>;
  by_status: Array<{ http_status: number; count: number }>;
  tokens: ReturnType<typeof requestTokenStats>;
  tokens_by_key: KeyTokenRow[];
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
  return {
    by_key,
    by_model,
    by_status,
    tokens: requestTokenStats(db),
    tokens_by_key: tokenStatsByKey(db),
  };
}

export const OVERVIEW_CALL_CHART_DAYS = 14;

export function requestCallsByDay(
  db: DatabaseSync,
  days = OVERVIEW_CALL_CHART_DAYS,
): Array<{ day: string; count: number }> {
  const span = Math.max(1, Math.min(Math.trunc(days), 366));
  const now = new Date();
  const endUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = endUtc - (span - 1) * 86_400_000;
  const startDay = new Date(startMs).toISOString().slice(0, 10);
  const counted = new Map(
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM request_logs
         WHERE created_at >= ?
         GROUP BY day`,
      )
      .all(`${startDay}T00:00:00.000Z`)
      .map((row) => [asString(row.day), asNumber(row.count)] as const),
  );
  const series: Array<{ day: string; count: number }> = [];
  for (let i = 0; i < span; i += 1) {
    const day = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
    series.push({ day, count: counted.get(day) ?? 0 });
  }
  return series;
}

export function tokenStatsByKey(db: DatabaseSync): KeyTokenRow[] {
  return db
    .prepare(
      `SELECT
         api_key_id,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_usage_count
       FROM request_logs
       GROUP BY api_key_id`,
    )
    .all()
    .map((row) => ({
      api_key_id: asString(row.api_key_id),
      ...mapTokenTotals(row),
    }));
}

function migrateRequestLogs(db: DatabaseSync): void {
  const columns = new Set(
    db.prepare("PRAGMA table_info(request_logs)").all().map((row) => asString(row.name)),
  );
  if (!columns.has("path")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN path TEXT NOT NULL DEFAULT '/v1/chat/completions'");
  }
  if (!columns.has("upstream_ms")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN upstream_ms INTEGER");
  }
  if (!columns.has("gateway_ms")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN gateway_ms INTEGER");
  }
  if (!columns.has("request_detail")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN request_detail TEXT");
  }
  if (!columns.has("response_detail")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN response_detail TEXT");
  }
  if (!columns.has("cache_read_tokens")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER");
  }
  if (!columns.has("cache_write_tokens")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER");
  }
  if (!columns.has("reasoning_tokens")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model)");
}

function migrateSystemLogs(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      fields TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
  `);
}

function migrateConversations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      api_key_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_key_id, conversation_id)
    );
  `);
}

export function getConversationAgentId(
  db: DatabaseSync,
  apiKeyId: string,
  conversationId: string,
): string | undefined {
  const row = db
    .prepare(
      "SELECT agent_id FROM conversations WHERE api_key_id = ? AND conversation_id = ?",
    )
    .get(apiKeyId, conversationId);
  return row ? asString(row.agent_id) : undefined;
}

export function upsertConversation(
  db: DatabaseSync,
  apiKeyId: string,
  conversationId: string,
  agentId: string,
): void {
  db.prepare(
    `INSERT INTO conversations (api_key_id, conversation_id, agent_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(api_key_id, conversation_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       updated_at = excluded.updated_at`,
  ).run(apiKeyId, conversationId, agentId, new Date().toISOString());
}

export function insertSystemLog(
  db: DatabaseSync,
  entry: {
    level: string;
    message: string;
    fields?: Record<string, unknown> | string | null;
    id?: string;
    created_at?: string;
  },
): void {
  const fieldsJson =
    entry.fields === undefined || entry.fields === null
      ? null
      : typeof entry.fields === "string"
        ? entry.fields
        : JSON.stringify(entry.fields);
  db.prepare(
    `INSERT INTO system_logs (id, level, message, fields, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entry.id ?? randomUUID(),
    entry.level,
    entry.message,
    fieldsJson,
    entry.created_at ?? new Date().toISOString(),
  );
  pruneSystemLogs(db);
}

export function listSystemLogs(
  db: DatabaseSync,
  query: SystemLogQuery,
): { logs: SystemLogRow[]; total: number } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (query.level !== undefined && query.level !== "") {
    clauses.push("level = ?");
    params.push(query.level);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM system_logs ${where}`).get(...params);
  const logs = db
    .prepare(
      `SELECT id, level, message, fields, created_at
       FROM system_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset)
    .map(mapSystemLog);
  return { logs, total: totalRow ? asNumber(totalRow.count) : 0 };
}

export function pruneSystemLogs(db: DatabaseSync): number {
  const policy = logPolicies.get(db) ?? DEFAULT_LOG_POLICY;
  const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let removed = asNumber(db.prepare("DELETE FROM system_logs WHERE created_at < ?").run(cutoff).changes);
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM system_logs").get();
  const count = countRow ? asNumber(countRow.count) : 0;
  if (count > policy.maxRows) {
    const excess = count - policy.maxRows;
    removed += asNumber(
      db
        .prepare(
          `DELETE FROM system_logs
           WHERE id IN (
             SELECT id FROM system_logs ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(excess).changes,
    );
  }
  return removed;
}

function mapSystemLog(row: Record<string, unknown>): SystemLogRow {
  return {
    id: asString(row.id),
    level: asString(row.level),
    message: asString(row.message),
    fields: asNullableString(row.fields),
    created_at: asString(row.created_at),
  };
}

function mapRequestLogList(row: Record<string, unknown>): RequestLogRow {
  const mapped = mapRequestLog(row);
  mapped.request_detail = null;
  mapped.response_detail = null;
  mapped.has_detail = asNumber(row.has_detail) === 1;
  return mapped;
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
    cache_read_tokens: asNullableNumber(row.cache_read_tokens),
    cache_write_tokens: asNullableNumber(row.cache_write_tokens),
    reasoning_tokens: asNullableNumber(row.reasoning_tokens),
    error_code: asNullableString(row.error_code),
    created_at: asString(row.created_at),
    upstream_ms: asNullableNumber(row.upstream_ms),
    gateway_ms: asNullableNumber(row.gateway_ms),
    request_detail: asNullableString(row.request_detail),
    response_detail: asNullableString(row.response_detail),
    has_detail:
      asNullableString(row.request_detail) !== null || asNullableString(row.response_detail) !== null,
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
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      unknown_usage_count: 0,
    };
  }
  return {
    request_count: asNumber(row.request_count),
    input_tokens: asNumber(row.input_tokens),
    output_tokens: asNumber(row.output_tokens),
    total_tokens: asNumber(row.total_tokens),
    cache_read_tokens: asNumber(row.cache_read_tokens),
    cache_write_tokens: asNumber(row.cache_write_tokens),
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
