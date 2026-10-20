import type { DatabaseSync } from "node:sqlite";
import type { ApiKeyRow, CursorChatResult, KeyModelPolicy, ParsedChatRequest, QuotaPeriod } from "./contracts.js";
import { adjustKeyTokens, refundKeyRequest, reserveKeyRequest } from "./db.js";
import { concurrencyLimitExceeded, invalidRequest, quotaExceeded } from "./errors.js";
import { logInfo, logWarn } from "./log.js";
import { outputFormatInstruction } from "./output-limits.js";

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
  return canonicalTimeZone(tz) !== undefined;
}

/**
 * Canonical IANA name for `tz` (e.g. `asia/singapore` → `Asia/Singapore`), or undefined.
 * UTC offsets (`+08:00`, `-0500`) and other non-IANA forms are rejected even when the local ICU
 * accepts them, so a stored value stays valid across Node / ICU upgrades.
 */
export function canonicalTimeZone(tz: string): string | undefined {
  if (typeof tz !== "string" || tz.trim() === "" || tz.length > 64) return undefined;
  const value = tz.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(value)) return undefined;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return /^[+-]/.test(resolved) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

const warnedTimeZones = new Set<string>();

/** Read-time guard: a stored zone the runtime no longer knows falls back to UTC (logged once). */
function usableTimeZone(tz: string): string {
  if (canonicalTimeZone(tz) !== undefined) return tz;
  if (!warnedTimeZones.has(tz)) {
    warnedTimeZones.add(tz);
    logWarn("invalid quota_tz; using UTC", { quota_tz: tz });
  }
  return "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (formatters.size > 500) formatters.clear();
    formatters.set(tz, formatter);
  }
  return formatter;
}

function localParts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of `tz` at instant `ms`: local wall time minus UTC. */
function tzOffset(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant where local day y-m-d starts in `tz`. Usually local 00:00 (two passes handle DST
 * shifts). In zones that skip midnight for DST (Havana, Azores, Santiago, …) 00:00 does not exist;
 * then the first existing local instant of that day is returned (F4: was 1 h early).
 */
function localMidnightUtc(y: number, m: number, d: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - tzOffset(wall, tz);
  guess = wall - tzOffset(guess, tz);
  const onDay = (ms: number): boolean => {
    const p = localParts(ms, tz);
    return p.y === y && p.m === m && p.d === d;
  };
  if (onDay(guess)) {
    // Step back while still on the day (an offset change can leave the guess past 00:00).
    while (onDay(guess - 60_000)) guess -= 60_000;
    return guess;
  }
  // Landed on the previous day: the skipped hour. Find the first minute on the target day.
  let low = guess;
  let high = guess + 6 * 3_600_000;
  if (!onDay(high)) return guess;
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2 / 1000) * 1000;
    if (onDay(mid)) high = mid;
    else low = mid;
  }
  return high;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Storage key for the period containing `now`: `total`, `d:YYYY-MM-DD` or `m:YYYY-MM` (local to `tz`). */
export function periodKey(period: QuotaPeriod, tz: string, now = Date.now()): string {
  if (period === "total") return "total";
  const p = localParts(now, usableTimeZone(tz));
  return period === "daily" ? `d:${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : `m:${pad(p.y, 4)}-${pad(p.m)}`;
}

/** When the current period ends, or `null` for `total`. */
export function periodResetsAt(period: QuotaPeriod, zone: string, now = Date.now()): Date | null {
  if (period === "total") return null;
  const tz = usableTimeZone(zone);
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
 * Tokens charged for one HTTP turn:
 * 1. run-scoped usage (`run.wait().usage`, also after a client abort) minus what earlier tool
 *    rounds of the same run were already charged (`quota_precharged_tokens`);
 * 2. otherwise the gateway's conservative estimate `quota_estimate_tokens` (input + streamed text,
 *    thinking and tool-call arguments, ~4 chars per token): client aborts without usage, tool-call
 *    suspensions, cumulative-only (`agent_total`) usage;
 * 3. `null` when nothing is known (the admission reservation is then kept as the charge).
 * Swap it with `setQuotaUsageSource` (e.g. for a future official per-run usage API).
 */
export type QuotaUsageSource = (result: CursorChatResult, options: { cacheReadWeight: number }) => number | null;

/** Run-scoped total, with cache-read tokens counted at `cacheReadWeight` (1 = full weight). */
export const runScopedUsageSource: QuotaUsageSource = (result, options) => {
  if (result.usageKnown && (result.usageScope === undefined || result.usageScope === "run")) {
    const cacheRead = Math.min(result.usage.cache_read_tokens ?? 0, result.usage.total_tokens);
    const weighted = Math.ceil(result.usage.total_tokens - cacheRead + cacheRead * options.cacheReadWeight);
    const reported = Math.max(0, weighted - (result.quota_precharged_tokens ?? 0));
    // Aborted / failed runs (R2-2): upstream may report partial or zero usage after a cancel, so
    // never charge less than the local estimate of what was sent and produced.
    if (result.status !== "finished") return Math.max(reported, result.quota_estimate_tokens ?? 0);
    return reported;
  }
  if (result.quota_estimate_tokens !== undefined) return result.quota_estimate_tokens;
  return null;
};

let gatewayCacheReadWeight = 1;

export function configureQuota(options: { cacheReadWeight: number }): void {
  gatewayCacheReadWeight = options.cacheReadWeight;
}

let usageSource: QuotaUsageSource = runScopedUsageSource;

export function setQuotaUsageSource(source: QuotaUsageSource | undefined): void {
  usageSource = source ?? runScopedUsageSource;
}

/** ~4 characters per token, at least 1: the same rough rule as the local count_tokens estimate. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4));
}

/** Output allowance reserved per in-flight request on top of the input estimate (F2). */
export const QUOTA_RESERVE_OUTPUT_TOKENS = 1024;

let recentRunsWindow = 20;
/** Actual per-run charges of recent runs, per client key (newest last, in-memory, per process). */
const recentRuns = new Map<string, number[]>();

/** `QUOTA_RESERVE_RECENT_RUNS`: how many recent runs feed the reservation (0 = input estimate only). */
export function configureQuotaReserve(options: { recentRuns: number }): void {
  recentRunsWindow = Math.max(0, Math.trunc(options.recentRuns));
  if (recentRunsWindow === 0) recentRuns.clear();
}

/** Records the actual token charge of one finished run for `apiKeyId` (R2-1). */
export function recordRunTokens(apiKeyId: string, tokens: number): void {
  if (recentRunsWindow === 0 || !Number.isFinite(tokens) || tokens <= 0) return;
  const runs = recentRuns.get(apiKeyId) ?? [];
  runs.push(Math.trunc(tokens));
  while (runs.length > recentRunsWindow) runs.shift();
  recentRuns.set(apiKeyId, runs);
}

/** Average actual tokens of the key's recent runs (0 without history). */
export function recentRunAverage(apiKeyId: string): number {
  const runs = recentRuns.get(apiKeyId);
  if (!runs || runs.length === 0) return 0;
  return Math.ceil(runs.reduce((sum, value) => sum + value, 0) / runs.length);
}

export function clearRecentRuns(apiKeyId?: string): void {
  if (apiKeyId === undefined) recentRuns.clear();
  else recentRuns.delete(apiKeyId);
}

/**
 * Token reservation for one request at admission (R2-1): the larger of the input estimate plus a
 * fixed output allowance and the key's recent average actual run usage, so runs that use far more
 * than their visible input (harness prompt, tools, agent context) still reserve realistically.
 */
export function reservationFor(request: Pick<ParsedChatRequest, "messages" | "output_format">, apiKeyId?: string): number {
  // The JSON-mode instruction (with the full schema) is sent upstream too.
  let chars = outputFormatInstruction(request.output_format).length;
  for (const message of request.messages) {
    chars += message.content?.length ?? 0;
    for (const call of message.tool_calls ?? []) chars += (call.name?.length ?? 0) + (call.arguments?.length ?? 0);
  }
  const estimate = estimateTokens(chars) + QUOTA_RESERVE_OUTPUT_TOKENS;
  return apiKeyId === undefined ? estimate : Math.max(estimate, recentRunAverage(apiKeyId));
}

const inFlight = new Map<string, number>();
/** Live agents suspended on client tool calls; they occupy `max_concurrent` slots (F3). */
const parkedSlots = new Map<string, number>();

export function inFlightRequests(apiKeyId: string): number {
  return inFlight.get(apiKeyId) ?? 0;
}

export function parkedAgents(apiKeyId: string): number {
  return parkedSlots.get(apiKeyId) ?? 0;
}

/** Marks one suspended agent for `apiKeyId`; the returned release is idempotent. */
export function holdParkedSlot(apiKeyId: string): () => void {
  parkedSlots.set(apiKeyId, parkedAgents(apiKeyId) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = parkedAgents(apiKeyId) - 1;
    if (left > 0) parkedSlots.set(apiKeyId, left);
    else parkedSlots.delete(apiKeyId);
  };
}

export interface KeyTicket {
  readonly period: string;
  /** Tokens reserved at admission (0 without `quota_tokens`). */
  readonly reservedTokens: number;
  /** Call once the upstream run exists; before that, finishing refunds the request. */
  markStarted(): void;
  /** Idempotent. Releases the concurrency slot, refunds or settles tokens against the reservation. */
  finish(result: CursorChatResult | null): void;
}

const NOOP_TICKET: KeyTicket = { period: "total", reservedTokens: 0, markStarted() {}, finish() {} };

function hasQuota(key: ApiKeyRow): boolean {
  return key.quota_requests !== null || key.quota_tokens !== null || key.max_concurrent !== null;
}

export interface AdmitOptions {
  /** Tokens to reserve while the request runs (only with `quota_tokens`); see {@link reservationFor}. */
  reserveTokens?: number;
  /** Tool results for an agent suspended by this key: it already holds a slot. */
  resumesParked?: boolean;
}

/**
 * Admits one request for `key` or throws:
 * - 429 `concurrency_limit_exceeded` (Retry-After: 1) when `max_concurrent` slots are taken
 *   (in-flight HTTP requests plus agents suspended on tool calls);
 * - 429 `insufficient_quota` (Retry-After = seconds to next period; none for `total`).
 * With `quota_tokens`, `reserveTokens` is added to the period's tokens atomically at admission and
 * trued up on finish, so concurrent requests cannot all pass a nearly used-up token quota (F2).
 * Keys without any quota / concurrency setting return a no-op ticket (zero DB writes).
 */
export function admitKeyRequest(db: DatabaseSync, key: ApiKeyRow, now = Date.now(), options: AdmitOptions = {}): KeyTicket {
  if (!hasQuota(key)) return NOOP_TICKET;
  const current = inFlightRequests(key.id);
  const occupied = current + parkedAgents(key.id) - (options.resumesParked ? 1 : 0);
  if (key.max_concurrent !== null && occupied >= key.max_concurrent) {
    throw concurrencyLimitExceeded(key.max_concurrent);
  }
  const period = periodKey(key.quota_period, key.quota_tz, now);
  const metered = key.quota_requests !== null || key.quota_tokens !== null;
  const reserved = key.quota_tokens !== null ? Math.max(0, Math.trunc(options.reserveTokens ?? 0)) : 0;
  if (metered) {
    const reservation = reserveKeyRequest(db, key.id, period, {
      quotaRequests: key.quota_requests,
      quotaTokens: key.quota_tokens,
      reserveTokens: reserved,
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
    reservedTokens: reserved,
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
        refundKeyRequest(db, key.id, period, reserved);
        return;
      }
      const cacheReadWeight = key.quota_cache_read_weight ?? gatewayCacheReadWeight;
      const tokens = result ? usageSource(result, { cacheReadWeight }) : null;
      if (result && result.usageKnown && result.usageScope === "agent_total") {
        logInfo("quota used an estimate instead of cumulative usage", { api_key_id: key.id });
      }
      // Unknown usage keeps the reservation as the charge (conservative floor).
      const charge = tokens === null ? reserved : Math.max(0, Math.trunc(tokens));
      // Feed the next reservations with what finished runs really used (whole run, incl. tool rounds).
      // Weighted like the charge itself, so reservations match what this key is billed per run.
      if (result && tokens !== null && result.status === "finished" && result.usageKnown && (result.usageScope ?? "run") === "run") {
        recordRunTokens(key.id, tokens + (result.quota_precharged_tokens ?? 0));
      }
      adjustKeyTokens(db, key.id, period, charge - reserved);
    },
  };
}
