import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayError, httpStatusOf, requestTimeoutError, toOpenAiErrorBody, toSimpleErrorBody } from "./errors.js";
import { abortable, abortErrorOf } from "./request-lifecycle.js";

export function corsHeaders(req: IncomingMessage, allowOrigins: string[] = ["*"]): Record<string, string> {
  if (allowOrigins.length === 0) return {};
  const origin = req.headers.origin;
  const wildcard = allowOrigins.includes("*");
  if (!wildcard && (typeof origin !== "string" || !allowOrigins.includes(origin))) return { vary: "Origin" };
  return {
    "access-control-allow-origin": wildcard ? "*" : origin as string,
    ...(!wildcard ? { vary: "Origin" } : {}),
    "access-control-allow-headers": "Authorization, Content-Type, X-Api-Key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendOpenAiError(
  res: ServerResponse,
  error: unknown,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): void {
  const status = httpStatusOf(error);
  sendJson(res, status, toOpenAiErrorBody(error, requestId), {
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...extraHeaders,
    ...GatewayError.retryAfterHeaders(error),
    ...(error instanceof GatewayError && error.code === "payload_too_large" ? { connection: "close" } : {}),
  });
}

export function sendSimpleError(
  res: ServerResponse,
  error: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, httpStatusOf(error), toSimpleErrorBody(error), {
    ...GatewayError.retryAfterHeaders(error),
    ...(error instanceof GatewayError && error.code === "payload_too_large" ? { connection: "close" } : {}),
    ...extraHeaders,
  });
}

export function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function readClientToken(req: IncomingMessage): string | null {
  const bearer = readBearer(req);
  if (bearer) return bearer;
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].trim() !== "") {
    return header[0].trim();
  }
  return null;
}

export function readAdminToken(req: IncomingMessage): string | null {
  const bearer = readBearer(req);
  if (bearer) return bearer;
  const header = req.headers["x-management-key"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].trim() !== "") {
    return header[0].trim();
  }
  return null;
}

const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
let sseKeepaliveMs = DEFAULT_SSE_KEEPALIVE_MS;

export function configureSse(options: { keepaliveMs: number }): void {
  sseKeepaliveMs = Math.max(0, Math.floor(options.keepaliveMs));
}

export function beginSse(
  res: ServerResponse,
  requestId: string,
  extraHeaders?: Record<string, string>,
  options: { keepaliveMs?: number } = {},
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": requestId,
    ...extraHeaders,
  });
  res.flushHeaders();
  startSseKeepalive(res, options.keepaliveMs ?? sseKeepaliveMs);
}

function startSseKeepalive(res: ServerResponse, intervalMs: number): void {
  if (intervalMs <= 0) return;
  const stop = (): void => {
    clearInterval(timer);
    res.off("close", stop);
    res.off("finish", stop);
  };
  const timer = setInterval(() => {
    if (sseResponseClosed(res)) return stop();
    if (!res.writableNeedDrain) res.write(": keepalive\n\n");
  }, intervalMs);
  timer.unref();
  res.on("close", stop);
  res.on("finish", stop);
}

export interface SseWriteOptions {
  signal?: AbortSignal;
  /** Bound a backpressure wait; destroys the response when the bound expires. */
  timeoutMs?: number;
}

export async function writeSse(
  res: ServerResponse,
  data: unknown,
  options: SseWriteOptions = {},
): Promise<void> {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  await writeSseRaw(res, `data: ${payload}\n\n`, options);
}

export async function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
  options: SseWriteOptions = {},
): Promise<void> {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  await writeSseRaw(res, `event: ${event}\ndata: ${payload}\n\n`, options);
}

async function writeSseRaw(res: ServerResponse, frame: string, options: SseWriteOptions): Promise<void> {
  if (sseResponseClosed(res)) return;
  if (options.signal?.aborted) throw abortErrorOf(options.signal);
  const ok = res.write(frame);
  if (ok || sseResponseClosed(res)) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortErrorOf(options.signal as AbortSignal));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        res.destroy();
        reject(requestTimeoutError("Timed out writing the SSE response"));
      }, options.timeoutMs);
      timer.unref();
    }
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

function sseResponseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded || res.closed;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!signal) return await readJsonBodyUnbounded(req, maxBytes);
  let discard = signal.aborted;
  const onAbort = (): void => {
    discard = true;
    // Keep consuming the request after the HTTP handler returns so a timed-out upload does not
    // retain chunks or leave the connection half-read. The response layer adds Connection: close.
    req.resume();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (discard) req.resume();
  const read = readJsonBodyUnbounded(req, maxBytes, () => discard);
  try {
    return await abortable(read, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (discard) req.resume();
  }
}

async function readJsonBodyUnbounded(
  req: IncomingMessage,
  maxBytes: number,
  shouldDiscard: () => boolean = () => false,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // 超限是请求错误，提前结束读取不能销毁连接并被误判为客户端取消。
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if (shouldDiscard()) continue;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      req.resume();
      throw new GatewayError(
        400,
        "payload_too_large",
        `Request body exceeds ${String(maxBytes)} bytes`,
        "invalid_request_error",
      );
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayError(400, "invalid_json", "Request body must be valid JSON", "invalid_request_error");
  }
}
