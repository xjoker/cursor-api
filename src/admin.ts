import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ApiKeyRow, AppConfig } from "./contracts.js";
import { generateClientKey, requireAdminKey } from "./auth.js";
import {
  disableApiKey,
  deleteApiKey,
  enableApiKey,
  getApiKeyById,
  getRequestLogById,
  insertApiKey,
  listApiKeys,
  listRequestLogFilters,
  listRequestLogs,
  listSystemLogs,
  OVERVIEW_CALL_CHART_DAYS,
  requestCallsByDay,
  requestStats,
  SCHEMA_VERSION,
  tokenStatsByKey,
} from "./db.js";
import { GatewayError, invalidRequest } from "./errors.js";
import { readJsonBody, sendJson, sendSimpleError } from "./http.js";
import { listCursorModels, peekCursorAccount } from "./cursor.js";

const ADMIN_PREFIX = "/admin/api/";

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: AppConfig; db: DatabaseSync },
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
  ctx: { config: AppConfig; db: DatabaseSync },
): Promise<void> {
  const method = req.method ?? "";
  const pathname = url.pathname;
  const disableMatch = /^\/admin\/api\/keys\/([^/]+)\/disable$/.exec(pathname);
  const enableMatch = /^\/admin\/api\/keys\/([^/]+)\/enable$/.exec(pathname);
  const deleteMatch = /^\/admin\/api\/keys\/([^/]+)$/.exec(pathname);

  if (method === "GET" && pathname === "/admin/api/overview") {
    const keys = listApiKeys(ctx.db);
    const stats = requestStats(ctx.db);
    let upstream: "ok" | "unavailable" = "ok";
    try {
      await listCursorModels(ctx.config.cursorApiKey);
    } catch {
      upstream = "unavailable";
    }
    sendJson(res, 200, {
      version: ctx.config.version,
      git_commit: ctx.config.gitCommit,
      schema_version: SCHEMA_VERSION,
      upstream,
      account: peekCursorAccount(),
      keys: {
        total: keys.length,
        enabled: keys.filter((key) => key.enabled === 1).length,
      },
      request_count: stats.tokens.totals.request_count,
      tokens: stats.tokens,
      stats,
      calls_by_day: requestCallsByDay(ctx.db, OVERVIEW_CALL_CHART_DAYS),
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

  if (method === "GET" && pathname === "/admin/api/keys") {
    const usageById = new Map(tokenStatsByKey(ctx.db).map((row) => [row.api_key_id, row]));
    sendJson(res, 200, {
      keys: listApiKeys(ctx.db).map((key) => {
        const usage = usageById.get(key.id);
        return {
          ...publicKey(key),
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
