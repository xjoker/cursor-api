import { createHash } from "node:crypto";
import { GatewayError } from "./errors.js";
import { logInfo } from "./log.js";

/** Auth failures usually mean a revoked key; keep it out much longer than a rate limit. */
export const AUTH_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

export type CursorKeyFailure = "rate_limit" | "auth";

/** `round_robin` rotates evenly; `least_active` prefers the key with the fewest in-flight requests. */
export type CursorKeyStrategy = "round_robin" | "least_active";

export interface CursorKeyStatus {
  /** Stable, non-reversible fingerprint (sha256 prefix); the key itself is never exposed. */
  id: string;
  state: "healthy" | "cooling_down";
  cooldown_until: string | null;
  last_failure: CursorKeyFailure | null;
  consecutive_failures: number;
  requests: number;
  successes: number;
  failures: number;
  active_requests: number;
  last_used_at: string | null;
}

interface Entry {
  key: string;
  id: string;
  cooldownUntil: number;
  lastFailure: CursorKeyFailure | null;
  consecutiveFailures: number;
  requests: number;
  successes: number;
  failures: number;
  active: number;
  lastUsedAt: number;
}

/**
 * Upstream Cursor key pool: round-robin over healthy keys, cool down keys
 * that hit a rate limit or auth failure, and fail over to the next key.
 */
export class CursorKeyPool {
  private readonly entries: Entry[];
  private cursor = 0;

  constructor(
    keys: string[],
    private readonly options: { cooldownMs: number; strategy?: CursorKeyStrategy; now?: () => number },
  ) {
    const unique = [...new Set(keys.map((key) => key.trim()).filter((key) => key !== ""))];
    if (unique.length === 0) {
      throw new Error("CursorKeyPool needs at least one key");
    }
    this.entries = unique.map((key) => ({
      key,
      id: fingerprintKey(key),
      cooldownUntil: 0,
      lastFailure: null,
      consecutiveFailures: 0,
      requests: 0,
      successes: 0,
      failures: 0,
      active: 0,
      lastUsedAt: 0,
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The first configured key; used where one key is enough (e.g. model catalog cache). */
  get strategy(): CursorKeyStrategy {
    return this.options.strategy ?? "round_robin";
  }

  get primary(): string {
    return this.entries[0]?.key ?? "";
  }

  get primaryId(): string {
    return this.entries[0]?.id ?? "";
  }

  /**
   * Next key to use. Healthy keys rotate round-robin; `exclude` skips keys
   * that already failed for this request. When every candidate is cooling
   * down, the one that recovers first is returned so requests still go out.
   */
  pick(exclude: ReadonlySet<string> = new Set()): string | undefined {
    const now = this.now();
    const candidates = this.entries.filter((entry) => !exclude.has(entry.key));
    if (candidates.length === 0) return undefined;
    const healthy: Array<{ entry: Entry; step: number }> = [];
    for (let step = 0; step < this.entries.length; step += 1) {
      const entry = this.entries[(this.cursor + step) % this.entries.length];
      if (!entry || exclude.has(entry.key) || entry.cooldownUntil > now) continue;
      healthy.push({ entry, step });
    }
    if (healthy.length > 0) {
      let chosen = healthy[0];
      if (this.strategy === "least_active") {
        // Fewest in-flight requests wins; ties keep round-robin order.
        for (const candidate of healthy) {
          if (chosen && candidate.entry.active < chosen.entry.active) chosen = candidate;
        }
      }
      if (chosen) {
        this.cursor = (this.cursor + chosen.step + 1) % this.entries.length;
        chosen.entry.lastUsedAt = now;
        return chosen.entry.key;
      }
    }
    const soonest = [...candidates].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    if (soonest) soonest.lastUsedAt = now;
    return soonest?.key;
  }

  /** Marks a request in flight on `key`; call the returned function exactly once when it ends. */
  acquire(key: string): () => void {
    const entry = this.find(key);
    if (!entry) return () => undefined;
    entry.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
    };
  }

  reportSuccess(key: string): void {
    const entry = this.find(key);
    if (!entry) return;
    entry.requests += 1;
    entry.successes += 1;
    if (entry.consecutiveFailures > 0 || entry.cooldownUntil > 0) {
      logInfo("cursor key recovered", { key_id: entry.id });
    }
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
  }

  /**
   * Records an upstream failure. Returns true when the error is key-specific
   * (auth / rate limit) and another key may succeed.
   */
  reportFailure(key: string, error: unknown): boolean {
    const entry = this.find(key);
    const failure = classifyKeyFailure(error);
    if (!entry) return failure !== null;
    entry.requests += 1;
    if (failure === null) return false;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.lastFailure = failure;
    const base = failure === "auth" ? AUTH_FAILURE_COOLDOWN_MS : this.options.cooldownMs;
    // Back off harder on keys that keep failing (x1, x2, x4 … capped at x8).
    const factor = Math.min(8, 2 ** Math.max(0, entry.consecutiveFailures - 1));
    entry.cooldownUntil = this.now() + base * factor;
    logInfo("cursor key cooling down", {
      key_id: entry.id,
      reason: failure,
      cooldown_ms: base * factor,
      pool_size: this.entries.length,
    });
    return true;
  }

  /**
   * Runs `fn` with a pooled key, failing over to other keys on
   * auth / rate-limit errors. Other errors are returned unchanged.
   * `canRetry` lets callers stop failover once output reached the client.
   */
  async run<T>(
    fn: (key: string) => Promise<T>,
    canRetry: (error: unknown) => boolean = () => true,
    options: { record?: boolean } = {},
  ): Promise<T> {
    const record = options.record !== false;
    const tried = new Set<string>();
    let lastError: unknown;
    for (;;) {
      // `record: false` (admission prechecks): no rotation step and no success stats, so a
      // precheck does not double a key's request count or shift round-robin / least-used order.
      const cursor = this.cursor;
      const key = this.pick(tried);
      if (!record) this.cursor = cursor;
      if (key === undefined) throw lastError;
      tried.add(key);
      const release = record ? this.acquire(key) : () => undefined;
      try {
        const value = await fn(key);
        if (record) this.reportSuccess(key);
        return value;
      } catch (error) {
        lastError = error;
        // Precheck failures are classified for failover but not recorded (the real run records them).
        const keySpecific = record ? this.reportFailure(key, error) : classifyKeyFailure(error) !== null;
        const candidateSpecific = error instanceof GatewayError && error.code === "model_not_found";
        if ((!keySpecific && !candidateSpecific) || tried.size >= this.entries.length || !canRetry(error)) {
          throw error;
        }
      } finally {
        release();
      }
    }
  }

  /** Runs against the key that owns a persisted agent; ownership must never fail over. */
  async runForId<T>(id: string, fn: (key: string) => Promise<T>): Promise<T> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new GatewayError(
        503,
        "conversation_key_unavailable",
        "The Cursor key that owns this conversation is no longer configured",
        "upstream_error",
      );
    }
    entry.lastUsedAt = this.now();
    const release = this.acquire(entry.key);
    try {
      const value = await fn(entry.key);
      this.reportSuccess(entry.key);
      return value;
    } catch (error) {
      this.reportFailure(entry.key, error);
      throw error;
    } finally {
      release();
    }
  }

  snapshot(): CursorKeyStatus[] {
    const now = this.now();
    return this.entries.map((entry) => ({
      id: entry.id,
      state: entry.cooldownUntil > now ? "cooling_down" : "healthy",
      cooldown_until: entry.cooldownUntil > now ? new Date(entry.cooldownUntil).toISOString() : null,
      last_failure: entry.lastFailure,
      consecutive_failures: entry.consecutiveFailures,
      requests: entry.requests,
      successes: entry.successes,
      failures: entry.failures,
      active_requests: entry.active,
      last_used_at: entry.lastUsedAt > 0 ? new Date(entry.lastUsedAt).toISOString() : null,
    }));
  }

  private find(key: string): Entry | undefined {
    return this.entries.find((entry) => entry.key === key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function classifyKeyFailure(error: unknown): CursorKeyFailure | null {
  if (!(error instanceof GatewayError)) return null;
  if (error.code === "upstream_authentication_error") return "auth";
  if (error.code === "rate_limit_error") return "rate_limit";
  return null;
}

export function fingerprintKey(key: string): string {
  return `ck_${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}
