import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { handleAdminRequest } from "./admin.js";
import { requireClientKey } from "./auth.js";
import {
  admitKeyRequest,
  isListedModelAllowed,
  keyModelPolicy,
  needsModelPrecheck,
  type KeyTicket,
} from "./key-policy.js";
import { configureAuthThrottle } from "./auth-throttle.js";
import { loadConfig } from "./config.js";
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
import { GatewayError, cancelledError, httpStatusOf, modelNotFound } from "./errors.js";
import {
  beginSse,
  configureSse,
  corsHeaders,
  readJsonBody,
  sendJson,
  sendAnthropicError,
  sendOpenAiError,
  writeSse,
  writeSseEvent,
} from "./http.js";
import {
  AnthropicStreamWriter,
  encodeAnthropicMessage,
  estimateAnthropicInputTokens,
  newAnthropicMessageId,
  parseAnthropicMessagesRequest,
} from "./anthropic.js";
import { logError, logInfo, setSystemLogWriter, truncateUtf8 } from "./log.js";
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
  configureSessionLimits,
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
startSessionSweeper({ db, conversationTtlDays: config.conversationTtlDays });
setSystemLogWriter((entry) => {
  insertSystemLog(db, entry);
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

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    logError("unhandled request error", {
      code: error instanceof GatewayError ? error.code : "server_error",
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: "Internal server error", code: "server_error" });
  });
});

server.listen(config.gatewayPort, config.gatewayHost, () => {
  logInfo("gateway listening", {
    host: config.gatewayHost,
    port: config.gatewayPort,
    version: config.version,
  });
  warmCursorAccount(keyPool.primary);
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          messages: "POST /v1/messages (Anthropic)",
          count_tokens: "POST /v1/messages/count_tokens (estimate)",
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

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      await handleCountTokens(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      await handleMessages(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found", code: "not_found" }, cors);
  } catch (error) {
    logError("request failed", { path: url.pathname, code: error instanceof GatewayError ? error.code : "server_error" });
    if (url.pathname === "/v1/messages" || url.pathname.startsWith("/v1/messages/")) {
      sendAnthropicError(res, error, undefined, cors);
      return;
    }
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

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const key = requireClientKey(req, db, config.apiKeyPepper);

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

  try {
    const body = await readJsonBody(req, config.maxBodyBytes);
    model = peekModel(body);
    requestDetail = snapshotIncomingBody(body);
    const parsed = parseChatCompletionsRequest(body, { ignoreSamplingParams: config.ignoreSamplingParams });
    parsed.model = resolveModelAlias(config.modelAliases, parsed.model);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    validateChatTurnRequest(parsed);
    ticket = await admitTurn(key, parsed);
    if (config.logDetailed) {
      requestDetail = truncateUtf8(buildRequestDetail(parsed), config.logDetailedMaxBytes);
    }
    const headers = corsHeaders(req, config.corsAllowOrigins);

    const abort = new AbortController();
    let holdForTools = false;
    const onClose = (): void => {
      if (holdForTools) return;
      if (!res.writableEnded) abort.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    try {
      const collectedTools: OpenAiToolCall[] = [];
      const sink = parsed.stream
        ? {
            onText: async (text: string): Promise<void> => {
              if (text === "") return;
              await writeSse(
                res,
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
              await writeSse(
                res,
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
                await writeSse(
                  res,
                  encodeStreamChunk({
                    id: requestId,
                    created,
                    model: parsed.model,
                    tool_calls: [{ index, id: call.id, name: call.name, arguments: "" }],
                  }),
                );
                await writeSse(
                  res,
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
              await writeSse(
                res,
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

      if (result.finish_reason === "tool_calls") {
        holdForTools = true;
      }

      if (result.status === "cancelled" || result.finish_reason === "cancelled") {
        httpStatus = 499;
        errorCode = "cancelled";
        if (parsed.stream) {
          await writeSse(res, {
            error: {
              message: "Request cancelled",
              type: "cancelled",
              code: "cancelled",
            },
          });
          await writeSse(res, "[DONE]");
          res.end();
          return;
        }
        throw cancelledError();
      }
      if (result.status === "error" || result.finish_reason === "error") {
        throw runFailureError(result.error);
      }

      const toolCalls = result.tool_calls ?? collectedTools;
      const finishReason = result.finish_reason === "tool_calls" ? "tool_calls" : "stop";

      if (parsed.stream) {
        await writeSse(
          res,
          encodeStreamChunk({
            id: requestId,
            created,
            model: parsed.model,
            finish_reason: finishReason,
          }),
        );
        if (parsed.includeUsage && result.usageKnown) {
          await writeSse(
            res,
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
        await writeSse(res, "[DONE]");
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
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
  } catch (error) {
    httpStatus = httpStatusOf(error);
    errorCode = error instanceof GatewayError ? error.code : "server_error";
    errorMessage = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendOpenAiError(res, error, requestId, corsHeaders(req, config.corsAllowOrigins));
    } else {
      const mapped = error instanceof GatewayError ? error : null;
      await writeSse(res, {
        error: {
          message: mapped?.message ?? "Cursor request failed",
          type: mapped?.openaiType ?? "upstream_error",
          code: mapped?.code ?? "upstream_error",
        },
      });
      await writeSse(res, "[DONE]");
      res.end();
    }
  } finally {
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
      max_mode: maxModeOf(chatResult),
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
      max_mode: maxModeOf(chatResult) === 1,
      error_code: errorCode,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  }
}

async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireClientKey(req, db, config.apiKeyPepper);
  if (config.anthropicCountTokens === "off") {
    throw new GatewayError(404, "not_found", "count_tokens is disabled on this gateway", "invalid_request_error");
  }
  const body = await readJsonBody(req, config.maxBodyBytes);
  // Validate the same shape /v1/messages accepts (count_tokens has no max_tokens).
  const parsed = parseAnthropicMessagesRequest(body);
  resolveModelAlias(config.modelAliases, parsed.model);
  sendJson(
    res,
    200,
    { input_tokens: estimateAnthropicInputTokens(body as Record<string, unknown>) },
    { "x-token-count-estimated": "true", ...corsHeaders(req, config.corsAllowOrigins) },
  );
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = newAnthropicMessageId();
  const key = requireClientKey(req, db, config.apiKeyPepper);

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
  let writer: AnthropicStreamWriter | undefined;

  try {
    const body = await readJsonBody(req, config.maxBodyBytes);
    model = peekModel(body);
    requestDetail = snapshotIncomingBody(body);
    const parsed = parseAnthropicMessagesRequest(body);
    parsed.model = resolveModelAlias(config.modelAliases, parsed.model);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    validateChatTurnRequest(parsed);
    ticket = await admitTurn(key, parsed);
    if (config.logDetailed) {
      requestDetail = truncateUtf8(buildRequestDetail(parsed), config.logDetailedMaxBytes);
    }
    const headers = corsHeaders(req, config.corsAllowOrigins);

    const abort = new AbortController();
    let holdForTools = false;
    const onClose = (): void => {
      if (holdForTools) return;
      if (!res.writableEnded) abort.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    try {
      const collectedTools: OpenAiToolCall[] = [];
      if (parsed.stream) {
        writer = new AnthropicStreamWriter(
          async (event, data) => {
            await writeSseEvent(res, event, data);
          },
          { id: requestId, model: parsed.model },
        );
      }
      const sink = {
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
      chatResult = result;
      if (result.usageKnown) usage = result.usage;

      if (result.finish_reason === "tool_calls") {
        holdForTools = true;
      }

      if (result.status === "cancelled" || result.finish_reason === "cancelled") {
        httpStatus = 499;
        errorCode = "cancelled";
        throw cancelledError();
      }
      if (result.status === "error" || result.finish_reason === "error") {
        httpStatus = 502;
        errorCode = "upstream_error";
        throw runFailureError(result.error);
      }

      const toolCalls = result.tool_calls ?? collectedTools;
      const finishReason = result.finish_reason === "tool_calls" ? "tool_calls" : "stop";

      if (parsed.stream) {
        await writer?.complete({
          content: result.text,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          finish_reason: finishReason,
          usage: result.usageKnown ? result.usage : null,
        });
        res.end();
      } else {
        sendJson(
          res,
          200,
          encodeAnthropicMessage({
            id: requestId,
            model: parsed.model,
            content: result.text,
            usage: result.usageKnown ? result.usage : null,
            cost: result.cost,
            params: result.params,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: finishReason,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          }),
          { "x-request-id": requestId, "request-id": requestId, ...headers },
        );
      }
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
  } catch (error) {
    httpStatus = httpStatusOf(error);
    errorCode = error instanceof GatewayError ? error.code : "server_error";
    errorMessage = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendAnthropicError(res, error, requestId, corsHeaders(req, config.corsAllowOrigins));
    } else {
      await writer?.fail(error);
      res.end();
    }
  } finally {
    ticket?.finish(chatResult);
    const durationMs = Date.now() - started;
    const gatewayMs = upstreamMs === null ? null : Math.max(0, durationMs - upstreamMs);
    responseDetail = snapshotResponseDetail(chatResult, errorCode, errorMessage);
    insertRequestLog(db, {
      id: requestId,
      api_key_id: key.id,
      path: "/v1/messages",
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
      max_mode: maxModeOf(chatResult),
    });
    logInfo("messages completed", {
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
      max_mode: maxModeOf(chatResult) === 1,
      error_code: errorCode,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  }
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = `resp_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const key = requireClientKey(req, db, config.apiKeyPepper);

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
  let writer: ResponsesStreamWriter | undefined;

  try {
    const body = await readJsonBody(req, config.maxBodyBytes);
    model = peekModel(body);
    requestDetail = snapshotIncomingBody(body);
    const parsed = parseResponsesRequest(body);
    parsed.model = resolveModelAlias(config.modelAliases, parsed.model);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    const resumeId = parsed.conversation_id;
    if (!parsed.conversation_id) {
      parsed.conversation_id = requestId;
      parsed.conversation_id_generated = true;
    }
    validateChatTurnRequest(parsed);
    ticket = await admitTurn(key, parsed);
    if (config.logDetailed) {
      requestDetail = truncateUtf8(buildRequestDetail(parsed), config.logDetailedMaxBytes);
    }
    const headers = corsHeaders(req, config.corsAllowOrigins);

    const abort = new AbortController();
    let holdForTools = false;
    const onClose = (): void => {
      if (holdForTools) return;
      if (!res.writableEnded) abort.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    try {
      const collectedTools: OpenAiToolCall[] = [];
      const customToolNames = new Set(parsed.customToolNames ?? []);
      if (parsed.stream) {
        writer = new ResponsesStreamWriter(
          async (event, data) => {
            await writeSseEvent(res, event, data);
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
      rememberResponseChain(key.id, resumeId, requestId);
      upstreamMs = Date.now() - upstreamStarted;
      chatResult = result;
      if (result.usageKnown) usage = result.usage;

      if (result.finish_reason === "tool_calls") {
        holdForTools = true;
      }

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
      const finishReason = result.finish_reason === "tool_calls" ? "tool_calls" : "stop";

      if (parsed.stream) {
        await writer?.complete({
          content: result.text,
          usage: result.usageKnown ? result.usage : null,
          cost: result.cost,
          params: result.params,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_content: result.reasoning,
          finish_reason: finishReason,
        });
        res.end();
      } else {
        sendJson(
          res,
          200,
          encodeNonStreamResponse({
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
          }),
          { "x-request-id": requestId, ...headers },
        );
      }
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
  } catch (error) {
    httpStatus = httpStatusOf(error);
    errorCode = error instanceof GatewayError ? error.code : "server_error";
    errorMessage = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendOpenAiError(res, error, requestId, corsHeaders(req, config.corsAllowOrigins));
    } else {
      const mapped = error instanceof GatewayError ? error : null;
      await writer?.fail({
        message: mapped?.message ?? "Cursor request failed",
        type: mapped?.openaiType ?? "upstream_error",
        code: mapped?.code ?? "upstream_error",
      });
      res.end();
    }
  } finally {
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
      max_mode: maxModeOf(chatResult),
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
      max_mode: maxModeOf(chatResult) === 1,
      error_code: errorCode,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
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
  return JSON.stringify({
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
  return truncateUtf8(JSON.stringify(body), config.logDetailedMaxBytes);
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
  return JSON.stringify({
    status: "error",
    error_code: errorCode,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

function buildResponseDetail(
  result: CursorChatResult | null,
  errorCode: string | null,
  errorMessage: string | null,
): string {
  return JSON.stringify({
    status: result?.status ?? (errorCode ? "error" : "unknown"),
    text: result?.text ?? "",
    usage: result?.usageKnown ? result.usage : null,
    cost: result?.cost ?? null,
    finish_reason: result?.finish_reason ?? null,
    tool_calls: result?.tool_calls?.map((call) => call.name) ?? null,
    error_code: errorCode,
    ...(errorMessage ? { error_message: errorMessage } : {}),
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
async function admitTurn(key: ApiKeyRow, request: ParsedChatRequest): Promise<KeyTicket> {
  if (needsModelPrecheck(key)) {
    await keyPool.run((apiKey) => validateChatRequestModel(apiKey, request, modelOptionsFor(key)));
  }
  return admitKeyRequest(db, key);
}

/** 1 / 0 when a run happened, null when the request never reached a run. */
function maxModeOf(result: CursorChatResult | null): number | null {
  if (!result) return null;
  return result.max_mode === true ? 1 : 0;
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
