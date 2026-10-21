/**
 * In-memory store behind `GET /v1/responses/{id}` (best-effort compatibility, not persistence):
 * the final Response object of each finished `POST /v1/responses` (unless `store: false`),
 * scoped to the client key that created it, kept for {@link RESPONSE_TTL_MS}. Lost on restart.
 *
 * Limits: at most {@link MAX_STORED_RESPONSES_PER_KEY} per client key and
 * {@link MAX_STORED_RESPONSES} in total. Payloads are retained as serialized UTF-8 bytes,
 * capped at {@link MAX_STORED_RESPONSE_BYTES_PER_KEY} per key and
 * {@link MAX_STORED_RESPONSE_BYTES} in total. Count pressure drops the oldest entry of the key
 * holding the most entries; byte pressure drops the oldest entry of the key holding the most
 * bytes. Expired entries are purged before every read and write.
 */
export const RESPONSE_TTL_MS = 60 * 60 * 1000;
export const MAX_STORED_RESPONSES = 1000;
export const MAX_STORED_RESPONSES_PER_KEY = 100;
export const MAX_STORED_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_STORED_RESPONSE_BYTES_PER_KEY = 8 * 1024 * 1024;

interface Entry {
  payload: Buffer;
  expiresAt: number;
}

/** Per client key, insertion-ordered (oldest first). */
const stored = new Map<string, Map<string, Entry>>();
let total = 0;
const bytesByKey = new Map<string, number>();
let totalBytes = 0;

export interface ResponseStoreStats {
  entries: number;
  payloadBytes: number;
}

function removeEntry(apiKeyId: string, responseId: string, entries: Map<string, Entry>): boolean {
  const entry = entries.get(responseId);
  if (!entry) return false;
  entries.delete(responseId);
  total -= 1;
  totalBytes -= entry.payload.byteLength;
  bytesByKey.set(apiKeyId, (bytesByKey.get(apiKeyId) ?? 0) - entry.payload.byteLength);
  if (entries.size === 0) {
    stored.delete(apiKeyId);
    bytesByKey.delete(apiKeyId);
  }
  return true;
}

function dropOldest(apiKeyId: string, entries: Map<string, Entry>): void {
  const oldest = entries.keys().next().value;
  if (oldest === undefined) return;
  removeEntry(apiKeyId, oldest, entries);
}

function purgeExpired(now: number): void {
  for (const [apiKeyId, entries] of stored) {
    for (const [responseId, entry] of entries) {
      if (entry.expiresAt <= now) removeEntry(apiKeyId, responseId, entries);
    }
  }
}

function largestKeyByCount(): [string, Map<string, Entry>] | undefined {
  let largest: [string, Map<string, Entry>] | undefined;
  for (const [apiKeyId, entries] of stored) {
    if (!largest || entries.size > largest[1].size) largest = [apiKeyId, entries];
  }
  return largest;
}

function largestKeyByBytes(): [string, Map<string, Entry>] | undefined {
  let largest: [string, Map<string, Entry>] | undefined;
  for (const [apiKeyId, entries] of stored) {
    if (!largest || (bytesByKey.get(apiKeyId) ?? 0) > (bytesByKey.get(largest[0]) ?? 0)) {
      largest = [apiKeyId, entries];
    }
  }
  return largest;
}

export function storeResponse(apiKeyId: string, body: Record<string, unknown>, now = Date.now()): void {
  purgeExpired(now);
  const id = body.id;
  if (typeof id !== "string") return;

  const serialized = JSON.stringify(body);
  if (typeof serialized !== "string") return;
  const payloadBytes = Buffer.byteLength(serialized, "utf8");

  let entries = stored.get(apiKeyId);
  if (entries) {
    removeEntry(apiKeyId, id, entries);
  }

  if (payloadBytes > MAX_STORED_RESPONSE_BYTES_PER_KEY) return;
  const payload = Buffer.from(serialized, "utf8");
  entries = stored.get(apiKeyId);
  if (!entries) {
    entries = new Map();
    stored.set(apiKeyId, entries);
    bytesByKey.set(apiKeyId, 0);
  }
  entries.set(id, { payload, expiresAt: now + RESPONSE_TTL_MS });
  total += 1;
  totalBytes += payload.byteLength;
  bytesByKey.set(apiKeyId, (bytesByKey.get(apiKeyId) ?? 0) + payload.byteLength);
  while (
    entries.size > MAX_STORED_RESPONSES_PER_KEY ||
    (bytesByKey.get(apiKeyId) ?? 0) > MAX_STORED_RESPONSE_BYTES_PER_KEY
  ) {
    dropOldest(apiKeyId, entries);
  }
  while (total > MAX_STORED_RESPONSES) {
    const largest = largestKeyByCount();
    if (!largest) break;
    dropOldest(largest[0], largest[1]);
  }
  while (totalBytes > MAX_STORED_RESPONSE_BYTES) {
    const largest = largestKeyByBytes();
    if (!largest) break;
    dropOldest(largest[0], largest[1]);
  }
}

export function getStoredResponse(apiKeyId: string, responseId: string, now = Date.now()): Record<string, unknown> | undefined {
  purgeExpired(now);
  const entries = stored.get(apiKeyId);
  const entry = entries?.get(responseId);
  if (!entries || !entry) return undefined;
  return JSON.parse(entry.payload.toString("utf8")) as Record<string, unknown>;
}

export function responseStoreStats(now = Date.now()): ResponseStoreStats {
  purgeExpired(now);
  return { entries: total, payloadBytes: totalBytes };
}

export function clearStoredResponses(): void {
  stored.clear();
  bytesByKey.clear();
  total = 0;
  totalBytes = 0;
}
