import { createHash } from "node:crypto";
import type { ParsedChatMessage } from "./contracts.js";

/**
 * History-hash agent resume (SAF-95 PR C, opt-in via HISTORY_RESUME). A client that sends the
 * whole message history and no `conversation_id` would otherwise get a fresh Cursor agent with the
 * full transcript every turn. After a turn finishes normally the gateway remembers
 * `hash(messages + assistant reply) → agent`; when the next request's history before its last user
 * message hashes to that value, the gateway resumes the agent and sends only the new user message.
 *
 * Guarantees:
 * - **single use per agent state**: a record is removed the moment it is taken, and every other
 *   use of that agent (another record, a `previous_response_id` / `conversation_id` resume, a
 *   tool-result continuation) drops all records pointing at it ({@link forgetAgent}). A record
 *   therefore only ever resumes an agent whose context is exactly the hashed history; a
 *   regenerated or forked turn gets a new agent with the full transcript;
 * - scoped by client key and, when present, the client's `user` field; disabling or deleting a key
 *   drops its records ({@link forgetKey});
 * - entries expire after {@link HISTORY_TTL_MS} (expired ones are purged on the next write, at
 *   most once a minute); at most {@link MAX_HISTORY_ENTRIES_PER_KEY} per client key (that key's
 *   oldest dropped), so one key cannot evict another key's records; in memory only.
 * Callers check {@link historyResumeEnabled} once, before hashing anything.
 */
export const HISTORY_TTL_MS = 60 * 60 * 1000;
export const MAX_HISTORY_ENTRIES_PER_KEY = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface HistoryAgent {
  agentId: string;
  cursorKeyId?: string;
}

interface Entry extends HistoryAgent {
  expiresAt: number;
}

/** client key → (scope + hash → entry), insertion-ordered (oldest first). */
const entries = new Map<string, Map<string, Entry>>();
/** agentId → the [client key, record key] pairs that point at it. */
const byAgent = new Map<string, Set<string>>();
let enabled = false; // opt-in (HISTORY_RESUME); see README for why
let lastSweep = 0;

export function configureHistoryResume(options: { enabled: boolean }): void {
  enabled = options.enabled;
  if (!enabled) clearHistory();
}

export function historyResumeEnabled(): boolean {
  return enabled;
}

/**
 * Same fields as the session hash, but assistant text is trimmed (clients often strip trailing
 * whitespace) and the hash is versioned so it never collides with other session keys.
 */
export function hashHistory(messages: ParsedChatMessage[]): string {
  const payload = messages.map((message) => {
    const row: Record<string, unknown> = {
      role: message.role,
      content: message.role === "assistant" ? message.content.trim() : message.content,
    };
    if (message.images && message.images.length > 0) {
      row.images = message.images.map((image) => ("url" in image ? { url: image.url } : { data: image.data, mimeType: image.mimeType }));
    }
    if (message.tool_call_id) row.tool_call_id = message.tool_call_id;
    if (message.tool_calls && message.tool_calls.length > 0) {
      row.tool_calls = message.tool_calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
    }
    return row;
  });
  return `h1:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

/** Record key inside one client key: the client's `user` (if any) plus the history hash. */
function recordKey(user: string | undefined, hash: string): string {
  return `${user === undefined ? "-" : `u:${user}`}\u0000${hash}`;
}

const pairOf = (apiKeyId: string, key: string): string => `${apiKeyId}\u0001${key}`;

function deleteEntry(apiKeyId: string, keyEntries: Map<string, Entry>, key: string): void {
  const entry = keyEntries.get(key);
  if (!entry) return;
  keyEntries.delete(key);
  if (keyEntries.size === 0) entries.delete(apiKeyId);
  const pairs = byAgent.get(entry.agentId);
  pairs?.delete(pairOf(apiKeyId, key));
  if (pairs && pairs.size === 0) byAgent.delete(entry.agentId);
}

/** Drops expired entries everywhere (at most once per {@link SWEEP_INTERVAL_MS} unless forced). */
export function sweepHistory(now = Date.now(), force = false): void {
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [apiKeyId, keyEntries] of [...entries]) {
    for (const [key, entry] of [...keyEntries]) {
      if (entry.expiresAt <= now) deleteEntry(apiKeyId, keyEntries, key);
    }
  }
}

export function rememberHistory(
  apiKeyId: string,
  user: string | undefined,
  hash: string,
  agent: HistoryAgent,
  now = Date.now(),
): void {
  if (!enabled) return;
  sweepHistory(now);
  // The agent has moved on: older records for it describe a context it no longer has.
  forgetAgent(agent.agentId);
  let keyEntries = entries.get(apiKeyId);
  if (!keyEntries) {
    keyEntries = new Map();
    entries.set(apiKeyId, keyEntries);
  }
  const key = recordKey(user, hash);
  deleteEntry(apiKeyId, keyEntries, key);
  if (!entries.has(apiKeyId)) entries.set(apiKeyId, keyEntries);
  keyEntries.set(key, { ...agent, expiresAt: now + HISTORY_TTL_MS });
  const pairs = byAgent.get(agent.agentId) ?? new Set<string>();
  pairs.add(pairOf(apiKeyId, key));
  byAgent.set(agent.agentId, pairs);
  while (keyEntries.size > MAX_HISTORY_ENTRIES_PER_KEY) {
    const oldest = keyEntries.keys().next().value;
    if (oldest === undefined) break;
    deleteEntry(apiKeyId, keyEntries, oldest);
  }
}

/**
 * Takes the record for this history (atomically: it is removed before returning, together with
 * every other record of the same agent). Callers check {@link historyResumeEnabled} first.
 */
export function takeHistory(apiKeyId: string, user: string | undefined, hash: string, now = Date.now()): HistoryAgent | undefined {
  const keyEntries = entries.get(apiKeyId);
  const entry = keyEntries?.get(recordKey(user, hash));
  if (!keyEntries || !entry) return undefined;
  forgetAgent(entry.agentId);
  if (entry.expiresAt <= now) return undefined;
  return { agentId: entry.agentId, ...(entry.cursorKeyId ? { cursorKeyId: entry.cursorKeyId } : {}) };
}

/** Drops every record that points at `agentId` (the agent is being used by some other path). */
export function forgetAgent(agentId: string): void {
  const pairs = byAgent.get(agentId);
  if (!pairs) return;
  for (const pair of [...pairs]) {
    const split = pair.indexOf("\u0001");
    const apiKeyId = pair.slice(0, split);
    const keyEntries = entries.get(apiKeyId);
    if (keyEntries) deleteEntry(apiKeyId, keyEntries, pair.slice(split + 1));
  }
  byAgent.delete(agentId);
}

/** Drops all records of a client key (key disabled or deleted). */
export function forgetKey(apiKeyId: string): void {
  const keyEntries = entries.get(apiKeyId);
  if (!keyEntries) return;
  for (const key of [...keyEntries.keys()]) deleteEntry(apiKeyId, keyEntries, key);
  entries.delete(apiKeyId);
}

export function historyEntryCount(apiKeyId?: string): number {
  if (apiKeyId !== undefined) return entries.get(apiKeyId)?.size ?? 0;
  let total = 0;
  for (const keyEntries of entries.values()) total += keyEntries.size;
  return total;
}

export function clearHistory(): void {
  entries.clear();
  byAgent.clear();
  lastSweep = 0;
}
