import type { DatabaseSync } from "node:sqlite";
import type { ApiKeyRow, CursorChatResult, KeyModelPolicy, QuotaPeriod } from "./contracts.js";
import { addKeyTokens, refundKeyRequest, reserveKeyRequest } from "./db.js";
import { concurrencyLimitExceeded, invalidRequest, quotaExceeded } from "./errors.js";
import { logInfo } from "./log.js";

export const MAX_ALLOWED_MODEL_PATTERNS = 200;
export const MAX_ALLOWED_MODEL_PATTERN_LENGTH = 256;

// ---------------------------------------------------------------------------
// Model allowlist
// ---------------------------------------------------------------------------

interface CompiledAllowlist {
  exact: Set<string>;
  globs: RegExp[];
}

const compiledCache = new Map<string, { source: string; compiled: CompiledAllowlist }>();

export function keyModelPolicy(key: Pick<ApiKeyRow, "allowed_models" | "allow_max_mode">): KeyModelPolicy {
  return { allowedModels: key.allowed_models, allowMaxMode: key.allow_max_mode };
}

/**
 * True when the key carries any model or quota policy. Such requests resolve the model against the
 * catalog BEFORE admission, so 403/404 win over 429 and nothing is pre-charged for them.
 */
export function needsModelPrecheck(key: ApiKeyRow): boolean {
  return (
    key.allowed_models !== null ||
    key.allow_max_mode !== null ||
    key.quota_requests !== null ||
    key.quota_tokens !== null ||
    key.max_concurrent !== null
  );
}

function compile(patterns: string[]): CompiledAllowlist {
  const source = JSON.stringify(patterns);
  const cached = compiledCache.get(source);
  if (cached) return cached.compiled;
  const compiled: CompiledAllowlist = { exact: new Set(), globs: [] };
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "") continue;
    if (!pattern.includes("*")) {
      compiled.exact.add(pattern);
      continue;
    }
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    compiled.globs.push(new RegExp(`^${escaped}$`));
  }
  if (compiledCache.size > 1000) compiledCache.clear();
  compiledCache.set(source, { source, compiled });
  return compiled;
}

/** Does `name` match an entry (exact or `*` glob)? `null` allowlist = everything. */
export function matchesAllowlist(allowed: string[] | null, name: string): boolean {
  if (allowed === null) return true;
  const compiled = compile(allowed);
  const needle = name.trim().toLowerCase();
  return compiled.exact.has(needle) || compiled.globs.some((glob) => glob.test(needle));
}

function matchesExactEntry(allowed: string[], name: string): boolean {
  return compile(allowed).exact.has(name.trim().toLowerCase());
}

/**
 * Catalog-level decision. `requested` is the model name AFTER gateway `model_aliases`
 * were applied (so an alias can never grant access to its target); `canonicalId` is the
 * Cursor catalog id it resolved to.
 *
 * Allowed when the canonical id matches any entry (exact or glob), or when the requested
 * name equals an exact (non-glob) entry — e.g. an admin listing the catalog alias
 * `gemini-flash` explicitly. Globs never match catalog aliases, so `gemini-flash*`
 * cannot unlock whatever model the `gemini-flash` alias points at.
 */
export function isCatalogModelAllowed(
  policy: KeyModelPolicy | undefined,
  requested: string,
  canonicalId: string,
): boolean {
  if (!policy || policy.allowedModels === null) return true;
  return matchesAllowlist(policy.allowedModels, canonicalId) || matchesExactEntry(policy.allowedModels, requested);
}

/** For `/v1/models`: list a catalog entry when its id or one of its aliases is allowed. */
export function isListedModelAllowed(
  policy: KeyModelPolicy | undefined,
  model: { id: string; aliases?: string[] },
): boolean {
  if (!policy || policy.allowedModels === null) return true;
  if (matchesAllowlist(policy.allowedModels, model.id)) return true;
  return (model.aliases ?? []).some((alias) => matchesExactEntry(policy.allowedModels as string[], alias));
}

/** Validates admin input for `allowed_models`. */
export function parseAllowedModelsInput(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw invalidRequest("allowed_models must be an array of strings or null");
  }
  if (value.length > MAX_ALLOWED_MODEL_PATTERNS) {
    throw invalidRequest(`allowed_models accepts at most ${String(MAX_ALLOWED_MODEL_PATTERNS)} entries`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw invalidRequest("allowed_models entries must be non-empty strings");
    }
    const trimmed = item.trim();
    if (trimmed.length > MAX_ALLOWED_MODEL_PATTERN_LENGTH) {
      throw invalidRequest(`allowed_models entries must be at most ${String(MAX_ALLOWED_MODEL_PATTERN_LENGTH)} characters`);
    }
    if (/[\u0000-\u001f]/.test(trimmed)) {
      throw invalidRequest("allowed_models entries must not contain control characters");
    }
    if (!out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quota periods
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localParts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of `tz` at instant `ms`: local wall time minus UTC. */
function tzOffset(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local wall-clock midnight y-m-d in `tz` (two passes handle DST shifts). */
function localMidnightUtc(y: number, m: number, d: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - tzOffset(wall, tz);
  guess = wall - tzOffset(guess, tz);
  return guess;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Storage key for the period containing `now`: `total`, `d:YYYY-MM-DD` or `m:YYYY-MM` (local to `tz`). */
export function periodKey(period: QuotaPeriod, tz: string, now = Date.now()): string {
  if (period === "total") return "total";
  const p = localParts(now, tz);
  return period === "daily" ? `d:${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : `m:${pad(p.y, 4)}-${pad(p.m)}`;
}

/** When the current period ends, or `null` for `total`. */
export function periodResetsAt(period: QuotaPeriod, tz: string, now = Date.now()): Date | null {
  if (period === "total") return null;
  const p = localParts(now, tz);
  if (period === "daily") {
    const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    return new Date(localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz));
  }
  const next = new Date(Date.UTC(p.y, p.m, 1));
  return new Date(localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, tz));
}

// ---------------------------------------------------------------------------
// Admission (pre-charge) and settlement (post-charge)
// ---------------------------------------------------------------------------

/**
 * Picks the tokens to charge for one finished turn. The default only trusts run-scoped usage
 * (`run.wait().usage`); cumulative agent totals would double count resumed conversations.
 * Swap it with `setQuotaUsageSource` (e.g. for a future official per-run usage API).
 */
export type QuotaUsageSource = (result: CursorChatResult) => number | null;

export const runScopedUsageSource: QuotaUsageSource = (result) => {
  if (!result.usageKnown) return null;
  if (result.usageScope !== undefined && result.usageScope !== "run") return null;
  return result.usage.total_tokens;
};

let usageSource: QuotaUsageSource = runScopedUsageSource;

export function setQuotaUsageSource(source: QuotaUsageSource | undefined): void {
  usageSource = source ?? runScopedUsageSource;
}

const inFlight = new Map<string, number>();

export function inFlightRequests(apiKeyId: string): number {
  return inFlight.get(apiKeyId) ?? 0;
}

export interface KeyTicket {
  readonly period: string;
  /** Call once the upstream run exists; before that, finishing refunds the request. */
  markStarted(): void;
  /** Idempotent. Releases the concurrency slot, refunds or post-charges tokens. */
  finish(result: CursorChatResult | null): void;
}

const NOOP_TICKET: KeyTicket = { period: "total", markStarted() {}, finish() {} };

function hasQuota(key: ApiKeyRow): boolean {
  return key.quota_requests !== null || key.quota_tokens !== null || key.max_concurrent !== null;
}

/**
 * Admits one request for `key` or throws:
 * - 429 `concurrency_limit_exceeded` (Retry-After: 1) when `max_concurrent` slots are taken;
 * - 429 `insufficient_quota` (Retry-After = seconds to next period; none for `total`).
 * Keys without any quota / concurrency setting return a no-op ticket (zero DB writes).
 */
export function admitKeyRequest(db: DatabaseSync, key: ApiKeyRow, now = Date.now()): KeyTicket {
  if (!hasQuota(key)) return NOOP_TICKET;
  const current = inFlightRequests(key.id);
  if (key.max_concurrent !== null && current >= key.max_concurrent) {
    throw concurrencyLimitExceeded(key.max_concurrent);
  }
  const period = periodKey(key.quota_period, key.quota_tz, now);
  const metered = key.quota_requests !== null || key.quota_tokens !== null;
  if (metered) {
    const reservation = reserveKeyRequest(db, key.id, period, {
      quotaRequests: key.quota_requests,
      quotaTokens: key.quota_tokens,
    });
    if (!reservation.ok) {
      const resetsAt = periodResetsAt(key.quota_period, key.quota_tz, now);
      const retryAfter = resetsAt ? Math.max(1, Math.ceil((resetsAt.getTime() - now) / 1000)) : undefined;
      const used =
        reservation.reason === "requests"
          ? `requests ${String(reservation.requests)}/${String(key.quota_requests)}`
          : `tokens ${String(reservation.tokens)}/${String(key.quota_tokens)}`;
      throw quotaExceeded(
        `API key quota exceeded (${used}, period ${key.quota_period}${resetsAt ? `, resets ${resetsAt.toISOString()}` : ""})`,
        retryAfter,
      );
    }
  }
  inFlight.set(key.id, current + 1);
  let started = false;
  let done = false;
  return {
    period,
    markStarted() {
      started = true;
    },
    finish(result) {
      if (done) return;
      done = true;
      const left = inFlightRequests(key.id) - 1;
      if (left > 0) inFlight.set(key.id, left);
      else inFlight.delete(key.id);
      if (!metered) return;
      if (!started) {
        refundKeyRequest(db, key.id, period);
        return;
      }
      const tokens = result ? usageSource(result) : null;
      if (tokens !== null && tokens > 0) {
        addKeyTokens(db, key.id, period, tokens);
      } else if (result && result.usageKnown && result.usageScope === "agent_total") {
        logInfo("quota skipped cumulative usage", { api_key_id: key.id });
      }
    },
  };
}
