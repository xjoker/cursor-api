import type { IncomingMessage, ServerResponse } from "node:http";
import { cancelledError, GatewayError, requestTimeoutError, serverShuttingDownError } from "./errors.js";

/**
 * Request-scoped cancellation. `IncomingMessage.close` also fires after a normal
 * body has been consumed, so only `aborted` (or an incomplete, aborted request)
 * is treated as a client disconnect. The response close event is authoritative
 * once the response has started.
 */
export class RequestLifecycle {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onRequestAborted: () => void;
  private readonly onRequestClose: () => void;
  private readonly onResponseClose: () => void;
  private stopped = false;
  private abortError: GatewayError | undefined;
  private readonly req: IncomingMessage;
  private readonly res: ServerResponse;

  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    timeoutMs: number,
    private readonly onDone?: () => void,
  ) {
    this.req = req;
    this.res = res;
    this.onRequestAborted = () => this.abort(cancelledError());
    this.onRequestClose = () => {
      if (req.aborted || !req.complete) this.abort(cancelledError());
    };
    this.onResponseClose = () => {
      if (!res.writableEnded) this.abort(cancelledError());
    };
    req.on("aborted", this.onRequestAborted);
    req.on("close", this.onRequestClose);
    res.on("close", this.onResponseClose);
    if (timeoutMs > 0) {
      this.timer = setTimeout(() => this.abort(requestTimeoutError()), timeoutMs);
      this.timer.unref();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get error(): GatewayError | undefined {
    return this.abortError;
  }

  abortForShutdown(): void {
    this.abort(serverShuttingDownError());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // The listeners are removed by the owner only through the constructor's
    // captured request/response references; see dispose() below.
    this.dispose();
  }

  private abort(error: GatewayError): void {
    if (this.stopped || this.controller.signal.aborted) return;
    this.abortError = error;
    this.controller.abort(error);
  }

  private dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.req.off("aborted", this.onRequestAborted);
    this.req.off("close", this.onRequestClose);
    this.res.off("close", this.onResponseClose);
    this.onDone?.();
  }
}

/** Promise boundary used for SDK calls whose API has no AbortSignal option. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortErrorOf(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortErrorOf(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted) reject(abortErrorOf(signal));
        else resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function abortErrorOf(signal: AbortSignal): GatewayError {
  const reason = signal.reason;
  return reason instanceof GatewayError ? reason : cancelledError();
}
