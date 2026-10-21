import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { handleAdminRequest } from "./admin.js";
import { requireClientKey } from "./auth.js";
import {
  admitKeyRequest,
  configureQuota,
  configureQuotaReserve,
  isListedModelAllowed,
  keyModelPolicy,
  needsModelPrecheck,
  reservationFor,
  type KeyTicket,
} from "./key-policy.js";
import { configureAuthThrottle } from "./auth-throttle.js";
import { loadConfig } from "./config.js";
import { createKeyRateLimiter } from "./key-rate-limit.js";
import { resolveModelAlias } from "./model-alias.js";
import { CursorKeyPool } from "./keypool.js";
import {
  getConversationMapping,
  insertRequestLog,
  insertSystemLog,
  openDb,
  SCHEMA_VERSION,
  upsertConversation,
} from "./db.js";
import {
  GatewayError,
  cancelledError,
  httpStatusOf,
  modelNotFound,
  serverShuttingDownError,
} from "./errors.js";
import {
  beginSse,
  configureSse,
  corsHeaders,
  readJsonBody,
  sendJson,
  sendOpenAiError,
  writeSse,
  writeSseEvent,
} from "./http.js";
import { logError, logInfo, redactLogText, redactValue, setSystemLogWriter, truncateUtf8 } from "./log.js";
import { abortable, RequestLifecycle } from "./request-lifecycle.js";
import {
  encodeNonStreamCompletion,
  encodeStreamChunk,
  parseChatCompletionsRequest,
} from "./openai.js";
import {
  encodeNonStreamResponse,
  parseResponsesRequest,
  ResponsesStreamWriter,
} from "./responses.js";
import { getStoredResponse, storeResponse } from "./response-store.js";
import { clientFinishReason } from "./output-limits.js";
import { configureHistoryResume } from "./history-resume.js";
import {
  configureMaxMode,
  getCursorModel,
  listCursorModels,
  runFailureError,
  validateChatRequestModel,
  warmCursorAccount,
  type ModelSelectionOptions,
} from "./cursor.js";
import {
  aliasLiveConversation,
  abortAllSessions,
  configureSessionLimits,
  pendingSessionOperationCount,
  resumesParkedTurn,
  runChatTurn,
  startSessionSweeper,
  validateChatTurnRequest,
} from "./session.js";
import type { ApiKeyRow, AppConfig, CursorChatResult, OpenAiToolCall, ParsedChatRequest, Usage } from "./contracts.js";

let config: AppConfig;
try {
  loadDotEnv();
  config = loadConfig();
} catch (error) {
  logError(error instanceof Error ? error.message : "invalid configuration");
  process.exit(1);
}

configureSse({ keepaliveMs: config.sseKeepaliveMs });
configureMaxMode({ allowMaxMode: config.allowMaxMode });
configureQuota({ cacheReadWeight: config.quotaCacheReadWeight });
configureQuotaReserve({ recentRuns: config.quotaReserveRecentRuns });
const keyRateLimiter = createKeyRateLimiter(config.rateLimitPerKey);
try {
  configureAuthThrottle(config.authFailureLimit, { trustedProxies: config.trustedProxies });
} catch (error) {
  logError(error instanceof Error ? error.message : "invalid trusted_proxies");
  process.exit(1);
}

const keyPool = new CursorKeyPool(config.cursorApiKeys, {
  cooldownMs: config.cursorKeyCooldownMs,
  strategy: config.cursorKeyStrategy,
});
if (keyPool.size > 1) {
  logInfo("cursor key pool enabled", {
    keys: keyPool.size,
    cooldown_ms: config.cursorKeyCooldownMs,
    strategy: config.cursorKeyStrategy,
  });
}

const db = openDb(config.dataDir, {
  retentionDays: config.logRetentionDays,
  maxRows: config.logMaxRows,
  maxDetailBytes: config.logMaxDetailBytes,
});
configureSessionLimits({ maxLiveSessions: config.maxLiveSessions });
configureHistoryResume({ enabled: config.historyResume });
const stopSessionSweeper = startSessionSweeper({ db, conversationTtlDays: config.conversationTtlDays });
let databaseOpen = true;
setSystemLogWriter((entry) => {
  if (databaseOpen) insertSystemLog(db, entry);
});
if (config.logDetailed) {
  logInfo("detailed request logs enabled", {
    retention_days: config.logRetentionDays,
    max_rows: config.logMaxRows,
    detailed_max_bytes: config.logDetailedMaxBytes,
    max_detail_bytes: config.logMaxDetailBytes,
  });
}
const adminPagePath = path.join(import.meta.dirname, "..", "public", "admin.html");

let draining = false;
let shutdownPromise: Promise<void> | undefined;
const activeHandlers = new Set<Promise<void>>();
const activeLifecycles = new Set<RequestLifecycle>();
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 2_000;

const server = createServer((req, res) => {
  if (draining) {
    const error = serverShuttingDownError();
    if ((req.url ?? "").startsWith("/v1/")) sendOpenAiError(res, error);
    else sendJson(res, error.httpStatus, { error: error.message, code: error.code });
    return;
  }
  const task = handleRequest(req, res).catch((error) => {
    logError("unhandled request error", {
      code: error instanceof GatewayError ? error.code : "server_error",
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: "Internal server error", code: "server_error" });
  });
  activeHandlers.add(task);
  void task.then(
    () => activeHandlers.delete(task),
    () => activeHandlers.delete(task),
  );
});

server.listen(config.gatewayPort, config.gatewayHost, () => {
  logInfo("gateway listening", {
    host: config.gatewayHost,
    port: config.gatewayPort,
    version: config.version,
  });
  warmCursorAccount(keyPool.primary);
});

process.on("SIGTERM", () => {
  void beginShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void beginShutdown("SIGINT");
});

async function beginShutdown(signal: string): Promise<void> {
  if (shutdownPromise) return await shutdownPromise;
  draining = true;
  shutdownPromise = shutdown(signal);
  return await shutdownPromise;
}

async function shutdown(signal: string): Promise<void> {
  let forced = false;
  let hardStop = false;
  const hardStopTimer = setTimeout(() => {
    hardStop = true;
    logError("gateway shutdown forced", {
      signal,
      forced: true,
      unsettled: true,
      active_handlers: activeHandlers.size,
      pending_session_operations: pendingSessionOperationCount(),
    });
    setSystemLogWriter(undefined);
    process.exit(1);
  }, config.shutdownTimeoutMs + SHUTDOWN_CLEANUP_TIMEOUT_MS + 1_000);
  const serverClose = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  try {
    const graceful = await waitForHandlers(config.shutdownTimeoutMs);
    if (!graceful) {
      forced = true;
      for (const lifecycle of [...activeLifecycles]) lifecycle.abortForShutdown();
      server.closeAllConnections?.();
    }
    abortAllSessions();
    stopSessionSweeper();

    // Keep the database open while request finally blocks settle. Uncancellable SDK work gets a
    // bounded cleanup window; if it remains pending, exit without pretending cleanup completed.
    const cleanupDeadline = Date.now() + SHUTDOWN_CLEANUP_TIMEOUT_MS;
    const handlersSettled = await waitForHandlers(remainingMs(cleanupDeadline));
    const sessionsSettled = handlersSettled && await waitForSessionCleanup(remainingMs(cleanupDeadline));
    server.closeIdleConnections?.();
    const serverSettled = handlersSettled && sessionsSettled && await waitForPromise(serverClose, remainingMs(cleanupDeadline));
    if (!handlersSettled || !sessionsSettled || !serverSettled) {
      forced = true;
      logError("gateway shutdown forced", {
        signal,
        forced: true,
        unsettled: true,
        active_handlers: activeHandlers.size,
        pending_session_operations: pendingSessionOperationCount(),
      });
      setSystemLogWriter(undefined);
      process.exit(1);
    }

    if (forced) logError("gateway shutdown forced", { signal, forced: true, unsettled: false });
    else logInfo("gateway shutdown complete", { signal, forced: false, unsettled: false });
    setSystemLogWriter(undefined);
    databaseOpen = false;
    try {
      db.close();
    } catch (error) {
      logError("database close failed", { error: error instanceof Error ? error.message : String(error) });
      forced = true;
    }
    const exitCode = forced ? 1 : 0;
    process.exitCode = exitCode;
    // Do not let unrelated SDK sockets/timers extend shutdown after the database is closed.
    setTimeout(() => process.exit(exitCode), 250);
  } finally {
    clearTimeout(hardStopTimer);
    if (hardStop) process.exit(1);
  }
}

async function waitForHandlers(timeoutMs: number): Promise<boolean> {
  if (activeHandlers.size === 0) return true;
  return await waitForPromise(Promise.all([...activeHandlers]), timeoutMs);
}

async function waitForSessionCleanup(timeoutMs: number): Promise<boolean> {
  if (pendingSessionOperationCount() === 0) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pendingSessionOperationCount() > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

async function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  return await Promise.race([
    promise.then(() => true, () => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, timeoutMs));
    timer.unref();
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (draining) {
    const error = serverShuttingDownError();
    if ((req.url ?? "").startsWith("/v1/")) sendOpenAiError(res, error);
    else sendJson(res, error.httpStatus, { error: error.message, code: error.code });
    return;
  }
  const cors = corsHeaders(req, config.corsAllowOrigins);
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "Invalid Host header", code: "invalid_request" });
    return;
  }
  try {
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const accept = req.headers.accept ?? "";
      if (accept.includes("text/html")) {
        res.writeHead(302, { location: "/admin/" });
        res.end();
        return;
      }
      sendJson(res, 200, {
        name: "cursor-api",
        version: config.version,
        git_commit: config.gitCommit,
        openai: {
          base_url: "/v1",
          chat_completions: "POST /v1/chat/completions",
          responses: "POST /v1/responses",
          response: "GET /v1/responses/{id} (in-memory, 1h)",
          models: "GET /v1/models",
          model: "GET /v1/models/{id}",
        },
        auth: {
          client: ["Authorization: Bearer <cgk_...>", "X-Api-Key: <cgk_...>"],
          admin: ["Authorization: Bearer <ADMIN_ACCESS_KEY>", "X-Management-Key: <ADMIN_ACCESS_KEY>"],
        },
        admin: "/admin/",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        version: config.version,
        git_commit: config.gitCommit,
        schema_version: SCHEMA_VERSION,
      });
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/admin" ||
        url.pathname === "/admin/" ||
        url.pathname === "/management.html")
    ) {
      const html = fs.readFileSync(adminPagePath, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(html);
      return;
    }

    if (await handleAdminRequest(req, res, url, { config, db, keyPool })) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const key = requireClientKey(req, db, config.apiKeyPepper);
      const policy = keyModelPolicy(key);
      const models = (await keyPool.run((apiKey) => listCursorModels(apiKey))).filter((model) =>
        isListedModelAllowed(policy, model),
      );
      logInfo("models listed", { api_key_id: key.id, count: models.length });
      sendJson(res, 200, { object: "list", data: models }, cors);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const key = requireClientKey(req, db, config.apiKeyPepper);
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      if (id === "") {
        throw modelNotFound(id);
      }
      const model = await keyPool.run((apiKey) => getCursorModel(apiKey, id));
      if (!model || !isListedModelAllowed(keyModelPolicy(key), model)) {
        throw modelNotFound(id);
      }
      sendJson(res, 200, model, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/responses/")) {
      const key = requireClientKey(req, db, config.apiKeyPepper);
      let id: string;
      try {
        id = decodeURIComponent(url.pathname.slice("/v1/responses/".length));
      } catch {
        throw new GatewayError(400, "invalid_request", "Malformed response id in path", "invalid_request_error");
      }
      const stored = id === "" || id.includes("/") ? undefined : getStoredResponse(key.id, id);
      if (!stored) {
        throw new GatewayError(404, "not_found", `Response '${id}' not found`, "invalid_request_error");
      }
      sendJson(res, 200, stored, cors);
      return;
    }

    sendJson(res, 404, { error: "Not found", code: "not_found" }, cors);
  } catch (error) {
    logError("request failed", { path: url.pathname, code: error instanceof GatewayError ? error.code : "server_error" });
    if (url.pathname.startsWith("/v1/")) {
      sendOpenAiError(res, error, undefined, cors);
      return;
    }
    sendJson(res, httpStatusOf(error), {
      error: error instanceof Error ? error.message : "Internal server error",
      code: error instanceof GatewayError ? error.code : "server_error",
    });
  }
}

function beginRequestLifecycle(req: IncomingMessage, res: ServerResponse): RequestLifecycle {
  let lifecycle!: RequestLifecycle;
  lifecycle = new RequestLifecycle(req, res, config.requestTimeoutMs, () => {
    activeLifecycles.delete(lifecycle);
  });
  activeLifecycles.add(lifecycle);
  return lifecycle;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const key = requireClientKey(req, db, config.apiKeyPepper);
  const lifecycle = beginRequestLifecycle(req, res);

  let model = "";
  let stream = 0;
  let httpStatus = 200;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let usage: Usage | null = null;
  let upstreamMs: number | null = null;
  let requestDetail: string | null = null;
  let responseDetail: string | null = null;
  let chatResult: CursorChatResult | null = null;
  let ticket: KeyTicket | undefined;
  let maxDispatched = false;
  let terminalSse = false;

  try {
    const body = await readJsonBody(req, config.maxBodyBytes, lifecycle.signal);
    model = peekModel(body);
    requestDetail = snapshotIncomingBody(body);
    const parsed = parseChatCompletionsRequest(body, {
      ignoreSamplingParams: config.ignoreSamplingParams,
      enforceOutputLimits: config.enforceOutputLimits,
    });
    parsed.model = resolveModelAlias(config.modelAliases, parsed.model);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    validateChatTurnRequest(parsed);
    ticket = await admitTurn(key, parsed, lifecycle.signal);
    if (config.logDetailed) {
      requestDetail = truncateUtf8(buildRequestDetail(parsed), config.logDetailedMaxBytes);
    }
    const headers = corsHeaders(req, config.corsAllowOrigins);

    const abort = lifecycle.controller;
    const writeFrame = (data: unknown): Promise<void> =>
      writeSse(res, data, { signal: terminalSse ? undefined : lifecycle.signal, timeoutMs: terminalSse ? 100 : config.requestTimeoutMs });

    const collectedTools: OpenAiToolCall[] = [];
    const sink = parsed.stream
        ? {
            onText: async (text: string): Promise<void> => {
              if (text === "") return;
              await writeFrame(
                encodeStreamChunk({
                  id: requestId,
                  created,
                  model: parsed.model,
                  content: text,
                }),
              );
            },
            onThinking: async (text: string): Promise<void> => {
              if (text === "") return;
              await writeFrame(
                encodeStreamChunk({
                  id: requestId,
                  created,
                  model: parsed.model,
                  reasoning_content: text,
                }),
              );
            },
            onToolCalls: async (calls: OpenAiToolCall[]): Promise<void> => {
              collectedTools.push(...calls);
              for (const [index, call] of calls.entries()) {
                await writeFrame(
                  encodeStreamChunk({
                    id: requestId,
                    created,
                    model: parsed.model,
                    tool_calls: [{ index, id: call.id, name: call.name, arguments: "" }],
                  }),
                );
                await writeFrame(
                  encodeStreamChunk({
                    id: requestId,
                    created,
                    model: parsed.model,
                    tool_calls: [{ index, arguments: call.arguments }],
                  }),
                );
              }
            },
          }
        : {
            onText: async (): Promise<void> => undefined,
            onThinking: async (): Promise<void> => undefined,
            onToolCalls: async (calls: OpenAiToolCall[]): Promise<void> => {
              collectedTools.push(...calls);
            },
          };

    const upstreamStarted = Date.now();
    const result = await runChatTurn({
        apiKey: keyPool.primary,
        keyPool,
        apiKeyId: key.id,
        workspaceDir: config.cursorWorkspace,
        request: parsed,
        abortSignal: abort.signal,
        onClaimed: parsed.stream
          ? async (): Promise<void> => {
              beginSse(res, requestId, headers);
              await writeFrame(
                encodeStreamChunk({
                  id: requestId,
                  created,
                  model: parsed.model,
                  role: "assistant",
                }),
              );
            }
          : undefined,
        sink,
        parkTimeoutMs: config.parkTimeoutMs,
        db,
        modelPolicy: modelOptionsFor(key),
        onUpstreamStarted: () => ticket?.markStarted(),
      });
    upstreamMs = Date.now() - upstreamStarted;
    chatResult = result;
    if (result.usageKnown) usage = result.usage;
    if (lifecycle.error) throw lifecycle.error;

    if (result.status === "cancelled" || result.finish_reason === "cancelled") {
        httpStatus = 499;
        errorCode = "cancelled";
        if (parsed.stream) {
          await writeFrame({
            error: {
              message: "Request cancelled",
              type: "cancelled",
              code: "cancelled",
            },
          });
          await writeFrame("[DONE]");
          res.end();
          return;
        }
        throw cancelledError();
      }
    if (result.status === "error" || result.finish_reason === "error") {
        throw runFailureError(result.error);
      }

    const toolCalls = result.tool_calls ?? collectedTools;
    const finishReason = clientFinishReason(result);

    if (parsed.stream) {
        await writeFrame(
          encodeStreamChunk({
            id: requestId,
            created,
            model: parsed.model,
            finish_reason: finishReason,
          }),
        );
        if (parsed.includeUsage && result.usageKnown) {
          await writeFrame(
            encodeStreamChunk({
              id: requestId,
              created,
              model: parsed.model,
              usage: result.usage,
              cost: result.cost,
              params: result.params,
            }),
          );
        }
        await writeFrame("[DONE]");
        res.end();
    } else {
        sendJson(
          res,
          200,
          encodeNonStreamCompletion({
            id: requestId,
            created,
            model: parsed.model,
            content: result.text,
            usage: result.usageKnown ? result.usage : null,
            cost: result.cost,
            params: result.params,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: finishReason,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          }),
          { "x-request-id": requestId, ...headers },
        );
    }
  } catch (error) {
    const effectiveError = lifecycle.error ?? error;
    httpStatus = httpStatusOf(effectiveError);
    errorCode = effectiveError instanceof GatewayError ? effectiveError.code : "server_error";
    maxDispatched = effectiveError instanceof GatewayError && effectiveError.maxModeDispatched === true;
    errorMessage = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
    if (!res.headersSent) {
      if (effectiveError instanceof GatewayError && effectiveError.code === "request_timeout") {
        res.setHeader("connection", "close");
      }
      if (!res.destroyed) sendOpenAiError(res, effectiveError, requestId, corsHeaders(req, config.corsAllowOrigins));
    } else {
      const mapped = effectiveError instanceof GatewayError ? effectiveError : null;
      terminalSse = true;
      try {
        await writeSse(res, {
          error: {
            message: mapped?.message ?? "Cursor request failed",
            type: mapped?.openaiType ?? "upstream_error",
            code: mapped?.code ?? "upstream_error",
          },
        }, { timeoutMs: 100 });
        await writeSse(res, "[DONE]", { timeoutMs: 100 });
        if (!res.writableEnded) res.end();
      } catch {
        res.destroy();
      }
    }
  } finally {
    try {
      ticket?.finish(chatResult);
      const durationMs = Date.now() - started;
      const gatewayMs = upstreamMs === null ? null : Math.max(0, durationMs - upstreamMs);
      responseDetail = snapshotResponseDetail(chatResult, errorCode, errorMessage);
      insertRequestLog(db, {
        id: requestId,
        api_key_id: key.id,
        path: "/v1/chat/completions",
        model,
        stream,
        http_status: httpStatus,
        duration_ms: durationMs,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_write_tokens: usage?.cache_write_tokens ?? null,
        reasoning_tokens: usage?.reasoning_tokens ?? null,
        error_code: errorCode,
        created_at: new Date().toISOString(),
        upstream_ms: upstreamMs,
        gateway_ms: gatewayMs,
        request_detail: requestDetail,
        response_detail: responseDetail,
        max_mode: maxModeOf(chatResult, maxDispatched),
        ...costFields(chatResult),
      });
      logInfo("chat completed", {
        request_id: requestId,
        api_key_id: key.id,
        model,
        stream: stream === 1,
        http_status: httpStatus,
        duration_ms: durationMs,
        upstream_ms: upstreamMs,
        gateway_ms: gatewayMs,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_write_tokens: usage?.cache_write_tokens ?? null,
        max_mode: maxModeOf(chatResult, maxDispatched) === 1,
        error_code: errorCode,
        ...(errorMessage ? { error_message: errorMessage } : {}),
      });
    } finally {
      lifecycle.stop();
    }
  }
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = `resp_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const key = requireClientKey(req, db, config.apiKeyPepper);
  const lifecycle = beginRequestLifecycle(req, res);

  let model = "";
  let stream = 0;
  let httpStatus = 200;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let usage: Usage | null = null;
  let upstreamMs: number | null = null;
  let requestDetail: string | null = null;
  let responseDetail: string | null = null;
  let chatResult: CursorChatResult | null = null;
  let ticket: KeyTicket | undefined;
  let maxDispatched = false;
  let writer: ResponsesStreamWriter | undefined;
  let terminalSse = false;

  try {
    const body = await readJsonBody(req, config.maxBodyBytes, lifecycle.signal);
    model = peekModel(body);
    requestDetail = snapshotIncomingBody(body);
    const parsed = parseResponsesRequest(body, { enforceOutputLimits: config.enforceOutputLimits });
    const keepResponse = !(typeof body === "object" && body !== null && (body as { store?: unknown }).store === false);
    parsed.model = resolveModelAlias(config.modelAliases, parsed.model);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    const resumeId = parsed.conversation_id;
    if (!parsed.conversation_id) {
      parsed.conversation_id = requestId;
      parsed.conversation_id_generated = true;
    }
    validateChatTurnRequest(parsed);
    ticket = await admitTurn(key, parsed, lifecycle.signal);
    if (config.logDetailed) {
      requestDetail = truncateUtf8(buildRequestDetail(parsed), config.logDetailedMaxBytes);
    }
    const headers = corsHeaders(req, config.corsAllowOrigins);

    const abort = lifecycle.controller;

    const collectedTools: OpenAiToolCall[] = [];
    const customToolNames = new Set(parsed.customToolNames ?? []);
    if (parsed.stream) {
        writer = new ResponsesStreamWriter(
          async (event, data) => {
            await writeSseEvent(res, event, data, {
              signal: terminalSse ? undefined : lifecycle.signal,
              timeoutMs: terminalSse ? 100 : config.requestTimeoutMs,
            });
          },
          { id: requestId, created, model: parsed.model },
          customToolNames,
        );
    }
    const sink = parsed.stream
        ? {
            onText: async (text: string): Promise<void> => {
              await writer?.onText(text);
            },
            onThinking: async (text: string): Promise<void> => {
              await writer?.onThinking(text);
            },
            onToolCalls: async (calls: OpenAiToolCall[]): Promise<void> => {
              collectedTools.push(...calls);
              await writer?.onToolCalls(calls);
            },
          }
        : {
            onText: async (): Promise<void> => undefined,
            onThinking: async (): Promise<void> => undefined,
            onToolCalls: async (calls: OpenAiToolCall[]): Promise<void> => {
              collectedTools.push(...calls);
            },
          };

    const upstreamStarted = Date.now();
    const result = await runChatTurn({
        apiKey: keyPool.primary,
        keyPool,
        apiKeyId: key.id,
        workspaceDir: config.cursorWorkspace,
        request: parsed,
        abortSignal: abort.signal,
        onClaimed: parsed.stream
          ? async (): Promise<void> => {
              beginSse(res, requestId, headers);
              await writer?.start();
            }
          : undefined,
        sink,
        parkTimeoutMs: config.parkTimeoutMs,
        db,
        modelPolicy: modelOptionsFor(key),
        onUpstreamStarted: () => ticket?.markStarted(),
      });
    upstreamMs = Date.now() - upstreamStarted;
    if (lifecycle.error) {
        chatResult = result;
        if (result.usageKnown) usage = result.usage;
        throw lifecycle.error;
    }
    rememberResponseChain(key.id, resumeId, requestId);
    chatResult = result;
    if (result.usageKnown) usage = result.usage;

    if (result.status === "cancelled" || result.finish_reason === "cancelled") {
        httpStatus = 499;
        errorCode = "cancelled";
        if (parsed.stream) {
          await writer?.complete({
            content: result.text,
            usage: result.usageKnown ? result.usage : null,
            cost: result.cost,
            params: result.params,
            tool_calls: result.tool_calls,
            reasoning_content: result.reasoning,
            finish_reason: "cancelled",
          });
          res.end();
          return;
        }
        throw cancelledError();
      }
    if (result.status === "error" || result.finish_reason === "error") {
        throw runFailureError(result.error);
      }

    const toolCalls = result.tool_calls ?? collectedTools;
    const finishReason = clientFinishReason(result);

    if (parsed.stream) {
        const final = await writer?.complete({
          content: result.text,
          usage: result.usageKnown ? result.usage : null,
          cost: result.cost,
          params: result.params,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_content: result.reasoning,
          finish_reason: finishReason,
        });
        if (final && keepResponse) storeResponse(key.id, final);
        res.end();
    } else {
        const final = encodeNonStreamResponse({
          id: requestId,
          created,
          model: parsed.model,
          content: result.text,
          usage: result.usageKnown ? result.usage : null,
          cost: result.cost,
          params: result.params,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          finish_reason: finishReason,
          customToolNames,
          ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
        });
        if (keepResponse) storeResponse(key.id, final);
        sendJson(res, 200, final, { "x-request-id": requestId, ...headers });
    }
  } catch (error) {
    const effectiveError = lifecycle.error ?? error;
    httpStatus = httpStatusOf(effectiveError);
    errorCode = effectiveError instanceof GatewayError ? effectiveError.code : "server_error";
    maxDispatched = effectiveError instanceof GatewayError && effectiveError.maxModeDispatched === true;
    errorMessage = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
    if (!res.headersSent) {
      if (effectiveError instanceof GatewayError && effectiveError.code === "request_timeout") {
        res.setHeader("connection", "close");
      }
      if (!res.destroyed) sendOpenAiError(res, effectiveError, requestId, corsHeaders(req, config.corsAllowOrigins));
    } else {
      const mapped = effectiveError instanceof GatewayError ? effectiveError : null;
      terminalSse = true;
      try {
        await writer?.fail({
          message: mapped?.message ?? "Cursor request failed",
          type: mapped?.openaiType ?? "upstream_error",
          code: mapped?.code ?? "upstream_error",
        });
        if (!res.writableEnded) res.end();
      } catch {
        res.destroy();
      }
    }
  } finally {
    try {
      ticket?.finish(chatResult);
      const durationMs = Date.now() - started;
      const gatewayMs = upstreamMs === null ? null : Math.max(0, durationMs - upstreamMs);
      responseDetail = snapshotResponseDetail(chatResult, errorCode, errorMessage);
      insertRequestLog(db, {
        id: requestId,
        api_key_id: key.id,
        path: "/v1/responses",
        model,
        stream,
        http_status: httpStatus,
        duration_ms: durationMs,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_write_tokens: usage?.cache_write_tokens ?? null,
        reasoning_tokens: usage?.reasoning_tokens ?? null,
        error_code: errorCode,
        created_at: new Date().toISOString(),
        upstream_ms: upstreamMs,
        gateway_ms: gatewayMs,
        request_detail: requestDetail,
        response_detail: responseDetail,
        max_mode: maxModeOf(chatResult, maxDispatched),
        ...costFields(chatResult),
      });
      logInfo("responses completed", {
        request_id: requestId,
        api_key_id: key.id,
        model,
        stream: stream === 1,
        http_status: httpStatus,
        duration_ms: durationMs,
        upstream_ms: upstreamMs,
        gateway_ms: gatewayMs,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_write_tokens: usage?.cache_write_tokens ?? null,
        max_mode: maxModeOf(chatResult, maxDispatched) === 1,
        error_code: errorCode,
        ...(errorMessage ? { error_message: errorMessage } : {}),
      });
    } finally {
      lifecycle.stop();
    }
  }
}

function rememberResponseChain(apiKeyId: string, resumeId: string | undefined, responseId: string): void {
  if (!resumeId || resumeId === responseId) return;
  aliasLiveConversation(apiKeyId, resumeId, responseId);
  const mapping = getConversationMapping(db, apiKeyId, resumeId);
  if (mapping) {
    upsertConversation(db, apiKeyId, responseId, mapping.agentId, mapping.cursorKeyId);
  }
}

function buildRequestDetail(parsed: ParsedChatRequest): string {
  return stringifyRedacted({
    model: parsed.model,
    stream: parsed.stream,
    messages: parsed.messages,
    ...(parsed.params?.length ? { params: parsed.params } : {}),
    ...(parsed.variant ? { variant: parsed.variant } : {}),
    ...(parsed.reasoning_effort ? { reasoning_effort: parsed.reasoning_effort } : {}),
    ...(parsed.verbosity ? { verbosity: parsed.verbosity } : {}),
    ...(parsed.images?.length ? { images: `${parsed.images.length} attached` } : {}),
    ...(parsed.tools?.length ? { tools: parsed.tools.map((tool) => tool.name) } : {}),
  });
}

function snapshotIncomingBody(body: unknown): string | null {
  if (!config.logDetailed) return null;
  return truncateUtf8(stringifyRedacted(body), config.logDetailedMaxBytes);
}

function snapshotResponseDetail(
  result: CursorChatResult | null,
  errorCode: string | null,
  errorMessage: string | null,
): string | null {
  if (config.logDetailed) {
    return truncateUtf8(
      buildResponseDetail(result, errorCode, errorMessage),
      config.logDetailedMaxBytes,
    );
  }
  if (!errorCode) return null;
  return stringifyRedacted({
    status: "error",
    error_code: errorCode,
    ...(errorMessage ? { error_message: redactLogText(errorMessage) } : {}),
  });
}

function buildResponseDetail(
  result: CursorChatResult | null,
  errorCode: string | null,
  errorMessage: string | null,
): string {
  return stringifyRedacted({
    status: result?.status ?? (errorCode ? "error" : "unknown"),
    text: result?.text ?? "",
    usage: result?.usageKnown ? result.usage : null,
    cost: result?.cost ?? null,
    finish_reason: result?.finish_reason ?? null,
    tool_calls: result?.tool_calls?.map((call) => call.name) ?? null,
    error_code: errorCode,
    ...(errorMessage ? { error_message: redactLogText(errorMessage) } : {}),
  });
}

function modelOptionsFor(key: ApiKeyRow): ModelSelectionOptions {
  return { allowedModels: key.allowed_models, allowMaxMode: key.allow_max_mode };
}

/**
 * Per-key gate before any upstream run: keys with a model / quota policy resolve the model first
 * (403 model_not_allowed / max_mode_not_allowed and 404 win over 429, nothing is pre-charged), then
 * the request is admitted (concurrency slot + atomic request pre-charge). Unrestricted keys skip both.
 */
async function admitTurn(
  key: ApiKeyRow,
  request: ParsedChatRequest,
  abortSignal?: AbortSignal,
): Promise<KeyTicket> {
  if (needsModelPrecheck(key)) {
    const preflight = keyPool.run(
      (apiKey) => validateChatRequestModel(apiKey, request, modelOptionsFor(key)),
      undefined,
      { record: false },
    );
    await (abortSignal ? abortable(preflight, abortSignal) : preflight);
  }
  const now = Date.now();
  keyRateLimiter.check(key.id, now);
  const ticket = admitKeyRequest(db, key, now, {
    reserveTokens: reservationFor(request, key.id),
    resumesParked: resumesParkedTurn(key.id, request),
  });
  keyRateLimiter.record(key.id, now);
  return ticket;
}

/**
 * 1 / 0 when a run happened, null when the request never reached a run. A send-stage max-mode
 * block (the max run was already sent, then cancelled) logs 1.
 */
function maxModeOf(result: CursorChatResult | null, dispatched = false): number | null {
  if (dispatched) return 1;
  if (!result) return null;
  return result.max_mode === true ? 1 : 0;
}

function costFields(result: CursorChatResult | null): {
  raw_cost_cents: number | null;
  charged_cents: number | null;
  cost_scope: "agent_total" | null;
} {
  const raw = result?.cost?.raw_cost_cents;
  const charged = result?.cost?.charged_cents;
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!valid(raw) || !valid(charged)) {
    return { raw_cost_cents: null, charged_cents: null, cost_scope: null };
  }
  return { raw_cost_cents: raw, charged_cents: charged, cost_scope: "agent_total" };
}

/** Redact before truncating so a cut can't leave a partial secret that the patterns no longer match. */
function stringifyRedacted(value: unknown): string {
  return JSON.stringify(redactValue(value));
}

function peekModel(body: unknown): string {
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "model" in body) {
    const model = (body as { model?: unknown }).model;
    return typeof model === "string" ? model : "";
  }
  return "";
}

function loadDotEnv(): void {
  const file = path.join(process.cwd(), ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
