import { GatewayError } from "./errors.js";

export const KEY_RATE_LIMIT_WINDOW_MS = 60_000;

interface TimestampQueue {
  values: number[];
  head: number;
}

/**
 * Synchronous, per-client-key rolling-window request limiter.
 *
 * Callers must run `check` before the request's other admission checks and call `record` only
 * after those checks have succeeded. Both methods are synchronous so the admission sequence has
 * no await between the check and record operations.
 */
export class KeyRateLimiter {
  readonly limitPerKey: number;
  private readonly requests = new Map<string, TimestampQueue>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(limitPerKey: number) {
    if (!Number.isInteger(limitPerKey) || limitPerKey < 0) {
      throw new RangeError("rate_limit_per_key must be a non-negative integer");
    }
    this.limitPerKey = limitPerKey;
  }

  /** Number of client-key queues currently retained in memory. */
  get size(): number {
    return this.requests.size;
  }

  /**
   * Throws a 429 when this key has reached its rolling-window limit. Expired entries are removed
   * before the count is checked, so a request exactly 60 seconds after the oldest entry is allowed.
   */
  check(keyId: string, now = Date.now()): void {
    if (this.limitPerKey === 0) return;
    const timestamp = validTimestamp(now);
    this.sweepExpired(timestamp);
    const queue = this.requests.get(keyId);
    if (!queue || !this.prune(keyId, queue, timestamp)) return;

    const count = queue.values.length - queue.head;
    if (count < this.limitPerKey) return;

    const oldest = queue.values[queue.head];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + KEY_RATE_LIMIT_WINDOW_MS - timestamp) / 1000),
    );
    const error = new GatewayError(
      429,
      "rate_limit_exceeded",
      `Rate limit exceeded for this API key (${String(this.limitPerKey)} requests per 60 seconds)`,
      "rate_limit_error",
    );
    error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  }

  /** Records one request that has already passed all other admission checks. */
  record(keyId: string, now = Date.now()): void {
    if (this.limitPerKey === 0) return;
    const timestamp = validTimestamp(now);
    this.sweepExpired(timestamp);
    const queue = this.requests.get(keyId) ?? { values: [], head: 0 };
    this.prune(keyId, queue, timestamp);
    queue.values.push(timestamp);
    this.requests.set(keyId, queue);
  }

  /** Sweeps idle keys on access at most once per rolling-window interval. */
  private sweepExpired(now: number): void {
    if (now < this.lastSweepAt || now - this.lastSweepAt < KEY_RATE_LIMIT_WINDOW_MS) return;
    this.lastSweepAt = now;
    for (const [keyId, queue] of this.requests) {
      this.prune(keyId, queue, now);
    }
  }

  /** Removes expired timestamps without repeatedly shifting the backing array. */
  private prune(keyId: string, queue: TimestampQueue, now: number): boolean {
    const cutoff = now - KEY_RATE_LIMIT_WINDOW_MS;
    while (queue.head < queue.values.length && queue.values[queue.head] <= cutoff) {
      queue.head += 1;
    }

    if (queue.head >= queue.values.length) {
      this.requests.delete(keyId);
      return false;
    }

    // Compact occasionally so long-lived keys do not retain an ever-growing prefix. The head
    // pointer makes normal expiry O(1) amortized; this copy runs only after a sizeable prefix.
    if (queue.head >= 1024 && queue.head * 2 >= queue.values.length) {
      queue.values = queue.values.slice(queue.head);
      queue.head = 0;
    }
    return true;
  }
}

export function createKeyRateLimiter(limitPerKey: number): KeyRateLimiter {
  return new KeyRateLimiter(limitPerKey);
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("rate limiter timestamp must be finite");
  return value;
}
