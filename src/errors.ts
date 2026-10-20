export class GatewayError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly openaiType: string;
  /** Seconds for a `Retry-After` header (429 responses). */
  retryAfterSeconds?: number;
  /** OpenAI `error.param` (e.g. "model"); `null` when not tied to one field. */
  param?: string;
  /** Set on a max-mode block raised after a max-mode run was already sent upstream (logged as max_mode=1). */
  maxModeDispatched?: boolean;

  constructor(httpStatus: number, code: string, message: string, openaiType: string) {
    super(message);
    this.name = "GatewayError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.openaiType = openaiType;
  }

  /** `Retry-After` header for errors that carry `retryAfterSeconds` (429 responses). */
  static retryAfterHeaders(error: unknown): Record<string, string> {
    return error instanceof GatewayError && error.retryAfterSeconds !== undefined
      ? { "retry-after": String(error.retryAfterSeconds) }
      : {};
  }
}

export function invalidRequest(message: string, code = "invalid_request"): GatewayError {
  return new GatewayError(400, code, message, "invalid_request_error");
}

export function modelNotFound(id: string): GatewayError {
  return new GatewayError(
    404,
    "model_not_found",
    `The model '${id}' does not exist`,
    "invalid_request_error",
  );
}

export function maxModeNotAllowed(id: string, options?: { dispatched?: boolean }): GatewayError {
  const error = new GatewayError(
    403,
    "max_mode_not_allowed",
    `The model '${id}' with the requested parameters only runs in Cursor max mode, which is not allowed here (allow_max_mode=false). Pick a non-max variant or params (see is_max_mode in GET /v1/models).`,
    "permission_error",
  );
  error.param = "model";
  if (options?.dispatched) error.maxModeDispatched = true;
  return error;
}

export function conversationBusyError(): GatewayError {
  return new GatewayError(
    409,
    "conversation_busy",
    "Conversation already has an active request",
    "invalid_request_error",
  );
}

export function authenticationError(message = "Invalid API key"): GatewayError {
  return new GatewayError(401, "authentication_error", message, "authentication_error");
}

export function permissionError(message: string): GatewayError {
  return new GatewayError(403, "permission_error", message, "permission_error");
}

export function modelNotAllowed(id: string, detail?: string): GatewayError {
  const error = new GatewayError(
    403,
    "model_not_allowed",
    detail ?? `The model '${id}' is not allowed for this API key`,
    "permission_error",
  );
  error.param = "model";
  return error;
}

/** OpenAI-style quota exhaustion: 429 + `insufficient_quota` (OpenAI SDKs do not auto-retry it). */
export function quotaExceeded(message: string, retryAfterSeconds?: number): GatewayError {
  const error = new GatewayError(429, "insufficient_quota", message, "insufficient_quota");
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export function concurrencyLimitExceeded(limit: number): GatewayError {
  const error = new GatewayError(
    429,
    "concurrency_limit_exceeded",
    `Too many concurrent requests for this API key (limit ${String(limit)})`,
    "rate_limit_error",
  );
  error.retryAfterSeconds = 1;
  return error;
}

export function rateLimitError(message: string): GatewayError {
  return new GatewayError(429, "rate_limit_error", message, "rate_limit_error");
}

export function payloadTooLarge(maxBytes: number): GatewayError {
  return new GatewayError(
    400,
    "payload_too_large",
    `Request body exceeds ${String(maxBytes)} bytes`,
    "invalid_request_error",
  );
}

export function upstreamAuthError(message = "Cursor authentication failed"): GatewayError {
  return new GatewayError(502, "upstream_authentication_error", message, "upstream_authentication_error");
}

export function upstreamError(message = "Cursor request failed"): GatewayError {
  return new GatewayError(502, "upstream_error", message, "upstream_error");
}

export function upstreamUnavailable(message = "Cursor is temporarily unavailable"): GatewayError {
  return new GatewayError(503, "upstream_unavailable", message, "upstream_error");
}

export function upstreamTimeout(message = "Cursor request timed out"): GatewayError {
  return new GatewayError(504, "upstream_timeout", message, "upstream_error");
}

export function cancelledError(message = "Request cancelled"): GatewayError {
  return new GatewayError(499, "cancelled", message, "cancelled");
}

export function serverError(message = "Internal server error"): GatewayError {
  return new GatewayError(500, "server_error", message, "server_error");
}

export function toOpenAiErrorBody(error: unknown, requestId?: string): {
  error: { message: string; type: string; code: string; param: string | null };
  code: string;
} {
  const mapped = error instanceof GatewayError ? error : serverError();
  return {
    error: {
      message: mapped.message,
      type: mapped.openaiType,
      code: mapped.code,
      param: mapped.param ?? null,
    },
    code: mapped.code,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export function toSimpleErrorBody(error: unknown): { error: string; code: string } {
  const mapped = error instanceof GatewayError ? error : serverError();
  return { error: mapped.message, code: mapped.code };
}

export function httpStatusOf(error: unknown): number {
  return error instanceof GatewayError ? error.httpStatus : 500;
}
