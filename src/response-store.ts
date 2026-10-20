/**
 * In-memory store behind `GET /v1/responses/{id}` (best-effort compatibility, not persistence):
 * the final Response object of each finished `POST /v1/responses` (unless `store: false`),
 * scoped to the client key that created it, kept for {@link RESPONSE_TTL_MS}, at most
 * {@link MAX_STORED_RESPONSES} entries (oldest dropped first). Lost on restart.
 */
export const RESPONSE_TTL_MS = 60 * 60 * 1000;
export const MAX_STORED_RESPONSES = 1000;

const stored = new Map<string, { body: Record<string, unknown>; expiresAt: number }>();

function keyOf(apiKeyId: string, responseId: string): string {
  return `${apiKeyId}\u0000${responseId}`;
}

export function storeResponse(apiKeyId: string, body: Record<string, unknown>, now = Date.now()): void {
  const id = body.id;
  if (typeof id !== "string") return;
  const key = keyOf(apiKeyId, id);
  stored.delete(key);
  stored.set(key, { body, expiresAt: now + RESPONSE_TTL_MS });
  while (stored.size > MAX_STORED_RESPONSES) {
    const oldest = stored.keys().next().value;
    if (oldest === undefined) break;
    stored.delete(oldest);
  }
}

export function getStoredResponse(apiKeyId: string, responseId: string, now = Date.now()): Record<string, unknown> | undefined {
  const key = keyOf(apiKeyId, responseId);
  const entry = stored.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    stored.delete(key);
    return undefined;
  }
  return entry.body;
}

export function clearStoredResponses(): void {
  stored.clear();
}
