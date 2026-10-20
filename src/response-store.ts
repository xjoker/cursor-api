/**
 * In-memory store behind `GET /v1/responses/{id}` (best-effort compatibility, not persistence):
 * the final Response object of each finished `POST /v1/responses` (unless `store: false`),
 * scoped to the client key that created it, kept for {@link RESPONSE_TTL_MS}. Lost on restart.
 *
 * Limits: at most {@link MAX_STORED_RESPONSES_PER_KEY} per client key (that key's oldest is
 * dropped first) and {@link MAX_STORED_RESPONSES} in total. When the total is full, the oldest
 * entry of the key holding the most entries is dropped, so one key cannot push out another
 * key's responses while it holds no more than that key does.
 */
export const RESPONSE_TTL_MS = 60 * 60 * 1000;
export const MAX_STORED_RESPONSES = 1000;
export const MAX_STORED_RESPONSES_PER_KEY = 100;

interface Entry {
  body: Record<string, unknown>;
  expiresAt: number;
}

/** Per client key, insertion-ordered (oldest first). */
const stored = new Map<string, Map<string, Entry>>();
let total = 0;

function dropOldest(apiKeyId: string, entries: Map<string, Entry>): void {
  const oldest = entries.keys().next().value;
  if (oldest === undefined) return;
  entries.delete(oldest);
  total -= 1;
  if (entries.size === 0) stored.delete(apiKeyId);
}

export function storeResponse(apiKeyId: string, body: Record<string, unknown>, now = Date.now()): void {
  const id = body.id;
  if (typeof id !== "string") return;
  let entries = stored.get(apiKeyId);
  if (!entries) {
    entries = new Map();
    stored.set(apiKeyId, entries);
  }
  if (entries.delete(id)) total -= 1;
  entries.set(id, { body, expiresAt: now + RESPONSE_TTL_MS });
  total += 1;
  while (entries.size > MAX_STORED_RESPONSES_PER_KEY) dropOldest(apiKeyId, entries);
  while (total > MAX_STORED_RESPONSES) {
    let largestKey: string | undefined;
    let largest: Map<string, Entry> | undefined;
    for (const [keyId, keyEntries] of stored) {
      if (!largest || keyEntries.size > largest.size) {
        largestKey = keyId;
        largest = keyEntries;
      }
    }
    if (largestKey === undefined || !largest) break;
    dropOldest(largestKey, largest);
  }
}

export function getStoredResponse(apiKeyId: string, responseId: string, now = Date.now()): Record<string, unknown> | undefined {
  const entries = stored.get(apiKeyId);
  const entry = entries?.get(responseId);
  if (!entries || !entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(responseId);
    total -= 1;
    if (entries.size === 0) stored.delete(apiKeyId);
    return undefined;
  }
  return entry.body;
}

export function clearStoredResponses(): void {
  stored.clear();
  total = 0;
}
