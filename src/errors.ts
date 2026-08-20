export class GatewayError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly openaiType: string;

  constructor(httpStatus: number, code: string, message: string, openaiType: string) {
    super(message);
    this.name = "GatewayError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.openaiType = openaiType;
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

export function authenticationError(message = "Invalid API key"): GatewayError {
  return new GatewayError(401, "authentication_error", message, "authentication_error");
}

export function permissionError(message: string): GatewayError {
  return new GatewayError(403, "permission_error", message, "permission_error");
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

export function cancelledError(message = "Request cancelled"): GatewayError {
  return new GatewayError(499, "cancelled", message, "cancelled");
}

export function serverError(message = "Internal server error"): GatewayError {
  return new GatewayError(500, "server_error", message, "server_error");
}

export function toOpenAiErrorBody(error: unknown, requestId?: string): {
  error: { message: string; type: string; code: string; param: null };
  code: string;
} {
  const mapped = error instanceof GatewayError ? error : serverError();
  return {
    error: {
      message: mapped.message,
      type: mapped.openaiType,
      code: mapped.code,
      param: null,
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
