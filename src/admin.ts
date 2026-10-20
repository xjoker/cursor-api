import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ApiKeyRow, AppConfig, QuotaPeriod } from "./contracts.js";
import type { CursorKeyPool } from "./keypool.js";
import { generateClientKey, requireAdminKey } from "./auth.js";
import {
  disableApiKey,
  countConversations,
  deleteApiKey,
  enableApiKey,
  getApiKeyById,
  getKeyUsageRow,
  getRequestLogById,
  insertApiKey,
  listApiKeys,
  listKeyUsage,
  resetKeyUsage,
  updateApiKeyPolicy,
  type ApiKeyPolicyFields,
  listRequestLogFilters,
  listRequestLogs,
  listSystemLogs,
  requestCallsByDay,
  requestStats,
  SCHEMA_VERSION,
  tokenStatsByKey,
} from "./db.js";
import { GatewayError, invalidRequest } from "./errors.js";
import { readJsonBody, sendJson, sendSimpleError } from "./http.js";
import { listCursorModels, peekCursorAccount } from "./cursor.js";
import { sessionStats } from "./session.js";
import {
  inFlightRequests,
  canonicalTimeZone,
  parseAllowedModelsInput,
  periodKey,
  periodResetsAt,
} from "./key-policy.js";
import { logInfo } from "./log.js";

const ADMIN_PREFIX = "/admin/api/";

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: AppConfig; db: DatabaseSync; keyPool: CursorKeyPool },
): Promise<boolean> {
  if (!url.pathname.startsWith(ADMIN_PREFIX)) {
    return false;
  }

  try {
    requireAdminKey(req, ctx.config.adminAccessKey);
    await dispatch(req, res, url, ctx);
  } catch (error) {
    sendSimpleError(res, error);
  }
  return true;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: AppConfig; db: DatabaseSync; keyPool: CursorKeyPool },
): Promise<void> {
  const method = req.method ?? "";
  const pathname = url.pathname;
  const disableMatch = /^\/admin\/api\/keys\/([^/]+)\/disable$/.exec(pathname);
  const enableMatch = /^\/admin\/api\/keys\/([^/]+)\/enable$/.exec(pathname);
  const deleteMatch = /^\/admin\/api\/keys\/([^/]+)$/.exec(pathname);
  const usageMatch = /^\/admin\/api\/keys\/([^/]+)\/usage$/.exec(pathname);
  const usageResetMatch = /^\/admin\/api\/keys\/([^/]+)\/usage\/reset$/.exec(pathname);

  if (method === "GET" && pathname === "/admin/api/overview") {
    const keys = listApiKeys(ctx.db);
    const stats = requestStats(ctx.db);
    let upstream: "ok" | "unavailable" = "ok";
    try {
      await ctx.keyPool.run((apiKey) => listCursorModels(apiKey));
    } catch {
      upstream = "unavailable";
    }
    sendJson(res, 200, {
      version: ctx.config.version,
      git_commit: ctx.config.gitCommit,
      schema_version: SCHEMA_VERSION,
      upstream,
      account: peekCursorAccount(),
      sessions: { ...sessionStats(), conversations_stored: countConversations(ctx.db) },
      cursor_keys: summarizeKeys(ctx.keyPool),
      keys: {
        total: keys.length,
        enabled: keys.filter((key) => key.enabled === 1).length,
      },
      request_count: stats.tokens.totals.request_count,
      tokens: stats.tokens,
      stats,
      calls_by_day: requestCallsByDay(ctx.db, 7),
      logs: {
        retention_days: ctx.config.logRetentionDays,
        max_rows: ctx.config.logMaxRows,
        detailed: ctx.config.logDetailed,
        detailed_max_bytes: ctx.config.logDetailedMaxBytes,
        max_detail_bytes: ctx.config.logMaxDetailBytes,
      },
    });
    return;
  }

  if (method === "GET" && pathname === "/admin/api/cursor-keys") {
    sendJson(res, 200, {
      strategy: ctx.keyPool.strategy,
      cooldown_ms: ctx.config.cursorKeyCooldownMs,
      keys: ctx.keyPool.snapshot(),
    });
    return;
  }

  if (method === "GET" && pathname === "/admin/api/keys") {
    const usageById = new Map(tokenStatsByKey(ctx.db).map((row) => [row.api_key_id, row]));
    sendJson(res, 200, {
      keys: listApiKeys(ctx.db).map((key) => {
        const usage = usageById.get(key.id);
        return {
          ...publicKey(key),
          usage_current: currentUsage(ctx.db, key),
          request_count: usage?.request_count ?? 0,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
          cache_read_tokens: usage?.cache_read_tokens ?? 0,
          cache_write_tokens: usage?.cache_write_tokens ?? 0,
          unknown_usage_count: usage?.unknown_usage_count ?? 0,
        };
      }),
    });
    return;
  }

  if (method === "POST" && pathname === "/admin/api/keys") {
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const parsed = parseCreateKeyBody(body);
    const generated = generateClientKey();
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      name: parsed.name,
      key_prefix: generated.prefix,
      key_digest: generated.digestPeppered(ctx.config.apiKeyPepper),
      created_at: now,
      updated_at: now,
      ...parsePolicyFields(body),
    };
    insertApiKey(ctx.db, row);
    const created = getApiKeyById(ctx.db, row.id);
    if (!created) {
      throw new GatewayError(500, "server_error", "Failed to persist API key", "api_error");
    }
    sendJson(res, 201, { ...publicKey(created), key: generated.plaintext });
    return;
  }

  if (method === "POST" && disableMatch) {
    const updated = disableApiKey(ctx.db, decodeURIComponent(disableMatch[1] ?? ""));
    if (!updated) {
      throw notFound("API key not found");
    }
    sendJson(res, 200, publicKey(updated));
    return;
  }

  if (method === "POST" && enableMatch) {
    const updated = enableApiKey(ctx.db, decodeURIComponent(enableMatch[1] ?? ""));
    if (!updated) {
      throw notFound("API key not found");
    }
    sendJson(res, 200, publicKey(updated));
    return;
  }

  if (method === "PATCH" && deleteMatch) {
    const id = decodeURIComponent(deleteMatch[1] ?? "");
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    if (!isRecord(body)) throw invalidRequest("Request body must be a JSON object");
    const patch: Partial<ApiKeyPolicyFields> & { name?: string } = parsePolicyFields(body);
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim() === "") {
        throw invalidRequest("name must be a non-empty string");
      }
      patch.name = body.name.trim();
    }
    const updated = updateApiKeyPolicy(ctx.db, id, patch);
    if (!updated) throw notFound("API key not found");
    logInfo("api key policy updated", { api_key_id: id, fields: Object.keys(patch) });
    sendJson(res, 200, { ...publicKey(updated), usage_current: currentUsage(ctx.db, updated) });
    return;
  }

  if (method === "GET" && usageMatch) {
    const key = getApiKeyById(ctx.db, decodeURIComponent(usageMatch[1] ?? ""));
    if (!key) throw notFound("API key not found");
    sendJson(res, 200, {
      api_key_id: key.id,
      quota_period: key.quota_period,
      quota_tz: key.quota_tz,
      current: currentUsage(ctx.db, key),
      history: listKeyUsage(ctx.db, key.id),
    });
    return;
  }

  if (method === "POST" && usageResetMatch) {
    const key = getApiKeyById(ctx.db, decodeURIComponent(usageResetMatch[1] ?? ""));
    if (!key) throw notFound("API key not found");
    const period = periodKey(key.quota_period, key.quota_tz);
    resetKeyUsage(ctx.db, key.id, period);
    logInfo("api key usage reset", { api_key_id: key.id, period_start: period });
    sendJson(res, 200, { api_key_id: key.id, current: currentUsage(ctx.db, key) });
    return;
  }

  if (method === "DELETE" && deleteMatch) {
    const deleted = deleteApiKey(ctx.db, decodeURIComponent(deleteMatch[1] ?? ""));
    if (!deleted) {
      throw notFound("API key not found");
    }
    sendJson(res, 200, publicKey(deleted));
    return;
  }

  if (method === "GET" && pathname === "/admin/api/logs/filters") {
    sendJson(res, 200, listRequestLogFilters(ctx.db));
    return;
  }

  const logDetailMatch = /^\/admin\/api\/logs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && logDetailMatch) {
    const row = getRequestLogById(ctx.db, decodeURIComponent(logDetailMatch[1] ?? ""));
    if (!row) {
      throw notFound("Request log not found");
    }
    sendJson(res, 200, row);
    return;
  }

  if (method === "GET" && pathname === "/admin/api/logs") {
    const query = parseLogQuery(url);
    const { logs, total } = listRequestLogs(ctx.db, query);
    sendJson(res, 200, {
      logs,
      total,
      limit: query.limit,
      offset: query.offset,
    });
    return;
  }

  if (method === "GET" && pathname === "/admin/api/system-logs") {
    const query = parseSystemLogQuery(url);
    const { logs, total } = listSystemLogs(ctx.db, query);
    sendJson(res, 200, {
      logs,
      total,
      limit: query.limit,
      offset: query.offset,
    });
    return;
  }

  if (method === "GET" && pathname === "/admin/api/stats") {
    sendJson(res, 200, requestStats(ctx.db));
    return;
  }

  throw notFound("Not found");
}

function publicKey(row: ApiKeyRow): Omit<ApiKeyRow, "key_digest" | "request_limit" | "used_requests"> {
  const { key_digest: _digest, request_limit: _limit, used_requests: _used, ...rest } = row;
  return rest;
}

/** Validates the optional per-key policy fields shared by POST /keys and PATCH /keys/{id}. */
function parsePolicyFields(body: unknown): Partial<ApiKeyPolicyFields> {
  if (!isRecord(body)) return {};
  const out: Partial<ApiKeyPolicyFields> = {};
  if (body.allowed_models !== undefined) out.allowed_models = parseAllowedModelsInput(body.allowed_models);
  if (body.allow_max_mode !== undefined) {
    if (body.allow_max_mode !== null && typeof body.allow_max_mode !== "boolean") {
      throw invalidRequest("allow_max_mode must be true, false or null (inherit gateway allow_max_mode)");
    }
    out.allow_max_mode = body.allow_max_mode;
  }
  if (body.quota_requests !== undefined) out.quota_requests = parseLimit0(body.quota_requests, "quota_requests");
  if (body.quota_tokens !== undefined) out.quota_tokens = parseLimit0(body.quota_tokens, "quota_tokens");
  if (body.max_concurrent !== undefined) {
    const value = parseLimit0(body.max_concurrent, "max_concurrent");
    if (value !== null && (value < 1 || value > 10_000)) {
      throw invalidRequest("max_concurrent must be between 1 and 10000, or null");
    }
    out.max_concurrent = value;
  }
  if (body.quota_period !== undefined) {
    if (body.quota_period !== "total" && body.quota_period !== "daily" && body.quota_period !== "monthly") {
      throw invalidRequest("quota_period must be 'total', 'daily' or 'monthly'");
    }
    out.quota_period = body.quota_period as QuotaPeriod;
  }
  if (body.quota_tz !== undefined) {
    const canonical = typeof body.quota_tz === "string" ? canonicalTimeZone(body.quota_tz) : undefined;
    if (canonical === undefined) {
      throw invalidRequest("quota_tz must be an IANA time zone such as 'UTC' or 'Asia/Singapore' (no UTC offsets)");
    }
    // Stored canonical (e.g. `asia/singapore` → `Asia/Singapore`).
    out.quota_tz = canonical;
  }
  return out;
}

function parseLimit0(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest(`${field} must be a non-negative integer or null`);
  }
  return value;
}

function currentUsage(db: DatabaseSync, key: ApiKeyRow): {
  period_start: string;
  requests: number;
  tokens: number;
  in_flight: number;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  resets_at: string | null;
} {
  const period = periodKey(key.quota_period, key.quota_tz);
  const row = getKeyUsageRow(db, key.id, period);
  const requests = row?.requests ?? 0;
  const tokens = row?.tokens ?? 0;
  return {
    period_start: period,
    requests,
    tokens,
    in_flight: inFlightRequests(key.id),
    remaining_requests: key.quota_requests === null ? null : Math.max(0, key.quota_requests - requests),
    remaining_tokens: key.quota_tokens === null ? null : Math.max(0, key.quota_tokens - tokens),
    resets_at: periodResetsAt(key.quota_period, key.quota_tz)?.toISOString() ?? null,
  };
}

function parseCreateKeyBody(body: unknown): { name: string } {
  if (!isRecord(body)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    throw invalidRequest("name must be a non-empty string");
  }
  return { name: body.name.trim() };
}

function parseLogQuery(url: URL): {
  limit: number;
  offset: number;
  model?: string;
  api_key_id?: string;
  http_status?: number;
  from?: string;
  to?: string;
} {
  const query: {
    limit: number;
    offset: number;
    model?: string;
    api_key_id?: string;
    http_status?: number;
    from?: string;
    to?: string;
  } = {
    limit: parseLimit(url),
    offset: parseOffset(url),
  };
  const model = url.searchParams.get("model");
  if (model !== null && model !== "") query.model = model;
  const apiKeyId = url.searchParams.get("api_key_id");
  if (apiKeyId !== null && apiKeyId !== "") query.api_key_id = apiKeyId;
  const status = url.searchParams.get("status");
  if (status !== null && status !== "") {
    if (!/^\d+$/.test(status)) {
      throw invalidRequest("status must be a non-negative integer");
    }
    query.http_status = Number(status);
  }
  const from = url.searchParams.get("from");
  if (from !== null && from !== "") query.from = parseTimeBound(from, "from");
  const to = url.searchParams.get("to");
  if (to !== null && to !== "") query.to = parseTimeBound(to, "to");
  return query;
}

function parseSystemLogQuery(url: URL): { limit: number; offset: number; level?: string } {
  const query: { limit: number; offset: number; level?: string } = {
    limit: parseLimit(url),
    offset: parseOffset(url),
  };
  const level = url.searchParams.get("level");
  if (level !== null && level !== "") {
    if (level !== "info" && level !== "error") {
      throw invalidRequest("level must be 'info' or 'error'");
    }
    query.level = level;
  }
  return query;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 50;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw invalidRequest("limit must be a positive integer");
  }
  return Math.min(Number(raw), 200);
}

function parseOffset(url: URL): number {
  const raw = url.searchParams.get("offset");
  if (raw === null || raw === "") return 0;
  if (!/^\d+$/.test(raw)) {
    throw invalidRequest("offset must be a non-negative integer");
  }
  return Number(raw);
}

function parseTimeBound(raw: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(raw)) {
    throw invalidRequest(`${field} must be an ISO-8601 datetime`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidRequest(`${field} must be an ISO-8601 datetime`);
  }
  return parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(message: string): GatewayError {
  return new GatewayError(404, "not_found", message, "invalid_request_error");
}

function summarizeKeys(pool: CursorKeyPool): { total: number; healthy: number } {
  const keys = pool.snapshot();
  return { total: keys.length, healthy: keys.filter((key) => key.state === "healthy").length };
}
