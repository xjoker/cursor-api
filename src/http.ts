import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayError, httpStatusOf, toOpenAiErrorBody, toSimpleErrorBody } from "./errors.js";

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return {
    "access-control-allow-origin": typeof origin === "string" && origin.length > 0 ? origin : "*",
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
  });
}

export function sendSimpleError(res: ServerResponse, error: unknown): void {
  sendJson(res, httpStatusOf(error), toSimpleErrorBody(error));
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

export function beginSse(
  res: ServerResponse,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": requestId,
    ...extraHeaders,
  });
}

export async function writeSse(res: ServerResponse, data: unknown): Promise<void> {
  if (sseResponseClosed(res)) return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const ok = res.write(`data: ${payload}\n\n`);
  if (ok || sseResponseClosed(res)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

function sseResponseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded || res.closed;
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
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
