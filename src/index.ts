import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { handleAdminRequest } from "./admin.js";
import { requireClientKey } from "./auth.js";
import { loadConfig } from "./config.js";
import { insertRequestLog, openDb, SCHEMA_VERSION } from "./db.js";
import { GatewayError, httpStatusOf, modelNotFound } from "./errors.js";
import { beginSse, corsHeaders, readJsonBody, sendJson, sendOpenAiError, writeSse } from "./http.js";
import { logError, logInfo } from "./log.js";
import {
  encodeNonStreamCompletion,
  encodeStreamChunk,
  parseChatCompletionsRequest,
  renderTranscript,
} from "./openai.js";
import { getCursorModel, listCursorModels, runCursorText, validateChatRequestModel, warmCursorAccount } from "./cursor.js";
import type { AppConfig, Usage } from "./contracts.js";

let config: AppConfig;
try {
  loadDotEnv();
  config = loadConfig();
} catch (error) {
  logError(error instanceof Error ? error.message : "invalid configuration");
  process.exit(1);
}

const db = openDb(config.dataDir, {
  retentionDays: config.logRetentionDays,
  maxRows: config.logMaxRows,
});
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
  warmCursorAccount(config.cursorApiKey);
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders(req);
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    if (await handleAdminRequest(req, res, url, { config, db })) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const key = requireClientKey(req, db, config.apiKeyPepper);
      const models = await listCursorModels(config.cursorApiKey);
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
      const model = await getCursorModel(config.cursorApiKey, id);
      if (!model) {
        throw modelNotFound(id);
      }
      sendJson(res, 200, model, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChat(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found", code: "not_found" });
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

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const key = requireClientKey(req, db, config.apiKeyPepper);

  let model = "";
  let stream = 0;
  let httpStatus = 200;
  let errorCode: string | null = null;
  let usage: Usage | null = null;

  try {
    const body = await readJsonBody(req, config.maxBodyBytes);
    model = peekModel(body);
    const parsed = parseChatCompletionsRequest(body);
    model = parsed.model;
    stream = parsed.stream ? 1 : 0;
    await validateChatRequestModel(config.cursorApiKey, parsed);
    const headers = corsHeaders(req);

    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) abort.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    try {
      const prompt = renderTranscript(parsed.messages);
      if (parsed.stream) {
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
        const result = await runCursorText({
          apiKey: config.cursorApiKey,
          workspaceDir: config.cursorWorkspace,
          request: parsed,
          prompt,
          abortSignal: abort.signal,
          onTextDelta: async (text) => {
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
        });
        if (result.usageKnown) usage = result.usage;
        if (result.status === "cancelled") {
          httpStatus = 499;
          errorCode = "cancelled";
          return;
        }
        if (result.status === "error") {
          httpStatus = 502;
          errorCode = "upstream_error";
          throw new GatewayError(502, "upstream_error", "Cursor request failed", "upstream_error");
        }
        await writeSse(
          res,
          encodeStreamChunk({
            id: requestId,
            created,
            model: parsed.model,
            finish_reason: "stop",
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
        const result = await runCursorText({
          apiKey: config.cursorApiKey,
          workspaceDir: config.cursorWorkspace,
          request: parsed,
          prompt,
          abortSignal: abort.signal,
        });
        if (result.usageKnown) usage = result.usage;
        if (result.status === "cancelled") {
          httpStatus = 499;
          errorCode = "cancelled";
        }
        if (result.status === "error") {
          httpStatus = 502;
          errorCode = "upstream_error";
          throw new GatewayError(502, "upstream_error", "Cursor request failed", "upstream_error");
        }
        sendJson(
          res,
          200,
          encodeNonStreamCompletion({
            id: requestId,
            created,
            model: parsed.model,
            content: result.text,
            usage: result.usage,
            cost: result.cost,
            params: result.params,
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
    if (!res.headersSent) {
      sendOpenAiError(res, error, requestId, corsHeaders(req));
    } else {
      await writeSse(res, {
        error: { message: "Cursor request failed", type: "upstream_error", code: "upstream_error" },
      });
      await writeSse(res, "[DONE]");
      res.end();
    }
  } finally {
    insertRequestLog(db, {
      id: requestId,
      api_key_id: key.id,
      path: "/v1/chat/completions",
      model,
      stream,
      http_status: httpStatus,
      duration_ms: Date.now() - started,
      input_tokens: usage?.prompt_tokens ?? null,
      output_tokens: usage?.completion_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null,
      error_code: errorCode,
      created_at: new Date().toISOString(),
    });
    logInfo("chat completed", {
      request_id: requestId,
      api_key_id: key.id,
      model,
      stream: stream === 1,
      http_status: httpStatus,
      duration_ms: Date.now() - started,
      input_tokens: usage?.prompt_tokens ?? null,
      output_tokens: usage?.completion_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null,
      error_code: errorCode,
    });
  }
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
