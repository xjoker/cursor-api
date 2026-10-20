import { createHash } from "node:crypto";
import type { ParsedChatMessage } from "./contracts.js";

/**
 * History-hash agent resume (SAF-95 PR C). A client that sends the whole message history and no
 * `conversation_id` would otherwise get a fresh Cursor agent with the full transcript every turn.
 * After a turn finishes normally the gateway remembers `hash(messages + assistant reply) → agent`;
 * when the next request's history before its last user message hashes to that value, the gateway
 * resumes the agent and sends only the new user message.
 *
 * Safety:
 * - an entry is single-use (taken on match), so a regenerated or branched turn that reuses the
 *   same history gets the full transcript instead of an agent that has already moved on;
 * - scoped by client key; entries expire after {@link HISTORY_TTL_MS}; at most
 *   {@link MAX_HISTORY_ENTRIES} (oldest dropped); in memory only (restart = full transcript);
 * - any mismatch (edited history, different system prompt, trimmed tool output…) is simply a
 *   miss; a failed resume falls back to the full transcript before anything is streamed.
 */
export const HISTORY_TTL_MS = 60 * 60 * 1000;
export const MAX_HISTORY_ENTRIES = 10_000;

export interface HistoryAgent {
  agentId: string;
  cursorKeyId?: string;
}

const entries = new Map<string, HistoryAgent & { expiresAt: number }>();
let enabled = true;

export function configureHistoryResume(options: { enabled: boolean }): void {
  enabled = options.enabled;
  if (!enabled) entries.clear();
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

function keyOf(apiKeyId: string, hash: string): string {
  return `${apiKeyId}\u0000${hash}`;
}

export function rememberHistory(apiKeyId: string, hash: string, agent: HistoryAgent, now = Date.now()): void {
  if (!enabled) return;
  const key = keyOf(apiKeyId, hash);
  entries.delete(key);
  entries.set(key, { ...agent, expiresAt: now + HISTORY_TTL_MS });
  while (entries.size > MAX_HISTORY_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Single-use lookup: a hit is removed so the same history can never resume the agent twice. */
export function takeHistory(apiKeyId: string, hash: string, now = Date.now()): HistoryAgent | undefined {
  if (!enabled) return undefined;
  const key = keyOf(apiKeyId, hash);
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  if (entry.expiresAt <= now) return undefined;
  return { agentId: entry.agentId, ...(entry.cursorKeyId ? { cursorKeyId: entry.cursorKeyId } : {}) };
}

export function historyEntryCount(): number {
  return entries.size;
}

export function clearHistory(): void {
  entries.clear();
}
