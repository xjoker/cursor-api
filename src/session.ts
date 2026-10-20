import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type InteractionUpdate,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKJsonValue,
} from "@cursor/sdk";
import type {
  CursorChatResult,
  OpenAiToolCall,
  OpenAiToolFunction,
  ParsedChatMessage,
  ParsedChatRequest,
} from "./contracts.js";
import {
  billedUsageOf,
  createLocalChatAgent,
  disposeAgent,
  mapCursorError,
  actualMaxMode,
  maxModeAllowedFor,
  resolveChatModel,
  resumeLocalChatAgent,
  runFailureError,
  toChatUsage,
} from "./cursor.js";
import { getConversationMapping, pruneConversations, upsertConversation, type ConversationMapping } from "./db.js";
import { conversationBusyError, GatewayError, invalidRequest, maxModeNotAllowed } from "./errors.js";
import { logError, logInfo, logWarn } from "./log.js";
import { fingerprintKey, type CursorKeyPool } from "./keypool.js";
import { imagesOfLastUser, renderTranscript } from "./openai.js";

const DEFAULT_PARK_TIMEOUT_MS = 5 * 60 * 1000;

export type ChatTurnKind =
  | {
      kind: "user";
      stem: ParsedChatMessage[];
      user: ParsedChatMessage;
    }
  | {
      kind: "tool_results";
      stem: ParsedChatMessage[];
      results: Array<{ toolCallId: string; content: string }>;
    };

export interface ChatTurnSink {
  onText(text: string): Promise<void>;
  onThinking(text: string): Promise<void>;
  onToolCalls(calls: OpenAiToolCall[]): Promise<void>;
}

interface ParkedCall {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

interface LiveSession {
  apiKeyId: string;
  cursorKeyId: string;
  agent: SDKAgent;
  run: Run | undefined;
  waitPromise: Promise<CursorChatResult> | undefined;
  parks: Map<string, ParkedCall>;
  batch: OpenAiToolCall[];
  batchReady: Deferred<OpenAiToolCall[]> | undefined;
  lastFlushed: string[];
  awaitingClient: boolean;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  parkTimer: ReturnType<typeof setTimeout> | undefined;
  indexKeys: string[];
  modelParams: CursorChatResult["params"];
  /** The selection resolved to a Cursor max-mode variant (billed at max rates). */
  /** ACTUAL max-mode flag: the SDK-resolved `agent.model` / `run.model`, else the gateway prediction. */
  maxMode: boolean;
  /** Whether max mode may be sent for this session (gateway flag and request policy). */
  allowMaxMode: boolean;
  /** Deltas held back until the run's SDK-resolved model passed the max-mode check. */
  heldDeltas?: InteractionUpdate[];
  text: string;
  thinking: string;
  sink: ChatTurnSink | undefined;
  lastRequestMessages: ParsedChatMessage[];
  conversationId?: string;
  parkTimeoutMs: number;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, LiveSession>();
/** Every session that owns a Cursor agent, once per session (`sessions` indexes several keys each). */
const liveSessions = new Set<LiveSession>();
const sessionCounters = { evicted: 0, expired: 0, rejected: 0, conversationsPruned: 0 };
let maxLiveSessions = 256;
let pendingSessionCreates = 0;

export interface SessionStats {
  live: number;
  parked: number;
  running: number;
  max: number;
  evicted_total: number;
  expired_total: number;
  rejected_total: number;
  conversations_pruned_total: number;
}

export function configureSessionLimits(options: { maxLiveSessions: number }): void {
  maxLiveSessions = Math.max(1, Math.floor(options.maxLiveSessions));
}

export function sessionStats(): SessionStats {
  let parked = 0;
  for (const session of liveSessions) {
    if (isAwaitingClient(session)) parked += 1;
  }
  return {
    live: liveSessions.size,
    parked,
    running: liveSessions.size - parked,
    max: maxLiveSessions,
    evicted_total: sessionCounters.evicted,
    expired_total: sessionCounters.expired,
    rejected_total: sessionCounters.rejected,
    conversations_pruned_total: sessionCounters.conversationsPruned,
  };
}

function isAwaitingClient(session: LiveSession): boolean {
  return session.awaitingClient && session.parks.size > 0;
}

/**
 * Makes room for one more session. At the cap, the least recently active
 * session that is only waiting for client tool results is evicted (its client
 * can still continue via transcript replay). If every session is actively
 * running, the request is refused with 503 instead of growing without bound.
 */
async function ensureSessionCapacity(apiKeyId: string): Promise<void> {
  while (liveSessions.size + pendingSessionCreates >= maxLiveSessions) {
    let victim: LiveSession | undefined;
    for (const session of liveSessions) {
      if (!isAwaitingClient(session)) continue;
      if (!victim || session.lastActiveAt < victim.lastActiveAt) victim = session;
    }
    if (!victim) {
      sessionCounters.rejected += 1;
      logInfo("session limit reached", { api_key_id: apiKeyId, live: liveSessions.size, max: maxLiveSessions });
      throw new GatewayError(
        503,
        "too_many_sessions",
        "Too many active Cursor sessions; retry shortly",
        "server_error",
      );
    }
    sessionCounters.evicted += 1;
    logInfo("evicted parked session", {
      api_key_id: victim.apiKeyId,
      idle_ms: Date.now() - victim.lastActiveAt,
      live: liveSessions.size,
      max: maxLiveSessions,
    });
    await dropSession(victim);
  }
  pendingSessionCreates += 1;
}

async function reserveSessionCapacity(apiKeyId: string): Promise<() => void> {
  await ensureSessionCapacity(apiKeyId);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    pendingSessionCreates -= 1;
  };
}

/**
 * Periodic safety net: drops parked sessions idle past twice their park
 * timeout (their own timer should already have fired) and prunes stale
 * conversation mappings from SQLite.
 */
export async function sweepSessions(options: {
  now?: number;
  db?: DatabaseSync;
  conversationTtlDays?: number;
}): Promise<{ expired: number; conversationsPruned: number }> {
  const now = options.now ?? Date.now();
  let expired = 0;
  for (const session of [...liveSessions]) {
    if (!isAwaitingClient(session)) continue;
    if (now - session.lastActiveAt <= session.parkTimeoutMs * 2) continue;
    expired += 1;
    await dropSession(session);
  }
  sessionCounters.expired += expired;
  let conversationsPruned = 0;
  if (options.db && options.conversationTtlDays !== undefined) {
    const cutoff = new Date(now - options.conversationTtlDays * 86_400_000).toISOString();
    conversationsPruned = pruneConversations(options.db, cutoff);
    sessionCounters.conversationsPruned += conversationsPruned;
  }
  if (expired > 0 || conversationsPruned > 0) {
    logInfo("session sweep", { expired, conversations_pruned: conversationsPruned, live: liveSessions.size });
  }
  return { expired, conversationsPruned };
}

export function startSessionSweeper(options: {
  db: DatabaseSync;
  conversationTtlDays: number;
  intervalMs?: number;
}): () => void {
  const timer = setInterval(() => {
    void sweepSessions(options).catch((error) => logError("session sweep failed", { error: error instanceof Error ? error.message : String(error) }));
  }, options.intervalMs ?? 60_000);
  timer.unref();
  void sweepSessions(options).catch((error) => logError("session sweep failed", { error: error instanceof Error ? error.message : String(error) }));
  return () => clearInterval(timer);
}
const activeConversationRequests = new Map<string, symbol>();

interface RunChatTurnOptions {
  apiKey: string;
  /** When set, new agents rotate across pooled keys and fail over on auth / rate-limit errors. */
  keyPool?: CursorKeyPool;
  apiKeyId: string;
  workspaceDir: string;
  request: ParsedChatRequest;
  abortSignal: AbortSignal;
  onClaimed?: () => Promise<void>;
  sink?: ChatTurnSink;
  parkTimeoutMs?: number;
  db?: DatabaseSync;
}

type TurnOptions = Omit<RunChatTurnOptions, "onClaimed"> & {
  claimOutput?: () => Promise<void>;
};

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export function classifyChatTurn(messages: ParsedChatMessage[]): ChatTurnKind {
  if (messages.length === 0) {
    throw invalidRequest("Field 'messages' must be a non-empty array");
  }
  let end = messages.length - 1;
  const results: Array<{ toolCallId: string; content: string }> = [];
  while (end >= 0 && messages[end]?.role === "tool") {
    const message = messages[end];
    if (!message?.tool_call_id) {
      throw invalidRequest("Tool messages require tool_call_id");
    }
    results.push({ toolCallId: message.tool_call_id, content: message.content });
    end -= 1;
  }
  if (results.length > 0) {
    const assistant = messages[end];
    if (!assistant || assistant.role !== "assistant" || !assistant.tool_calls?.length) {
      throw invalidRequest("Tool results must follow an assistant message with tool_calls");
    }
    return {
      kind: "tool_results",
      stem: messages.slice(0, end),
      results: results.reverse(),
    };
  }
  const last = messages[end];
  if (!last || last.role !== "user") {
    throw invalidRequest("Last message must be role 'user' or 'tool'");
  }
  return { kind: "user", stem: messages.slice(0, end), user: last };
}

export function toOpenAiToolCallId(raw: string | undefined): string {
  const fallback = `call_${randomUUID().replaceAll("-", "")}`;
  if (!raw) return fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (cleaned.length === 0) return fallback;
  const sliced = cleaned.slice(0, 64);
  return sliced.startsWith("call") ? sliced : `call_${sliced}`;
}

/** IDs we already sent as tool_calls but the client did not return. */
function missingFlushedToolResults(flushedIds: string[], receivedIds: string[]): string[] {
  const got = new Set(receivedIds);
  return flushedIds.filter((id) => !got.has(id));
}

export function hashMessages(messages: ParsedChatMessage[]): string {
  const payload = messages.map((message) => {
    const row: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.images) {
      row.images = message.images.map((image) =>
        "url" in image
          ? { url: image.url }
          : { data: image.data, mimeType: image.mimeType },
      );
    }
    if (message.tool_call_id) row.tool_call_id = message.tool_call_id;
    if (message.tool_calls) {
      row.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      }));
    }
    return row;
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type TurnAction = "continue_park" | "replay_transcript" | "resume_user" | "new_user";

export function resolveTurnAction(input: {
  turn: ChatTurnKind;
  hasParkedSession: boolean;
  conversationId?: string;
  canResumeConversation: boolean;
}): TurnAction {
  if (input.turn.kind === "tool_results") {
    return input.hasParkedSession ? "continue_park" : "replay_transcript";
  }
  if (input.conversationId && input.canResumeConversation) {
    return "resume_user";
  }
  return "new_user";
}

export function resolveParkedRoute(input: {
  conversationId?: string;
  conversationIdGenerated?: boolean;
  hasConversationParks: boolean;
  hasStemParks: boolean;
}): "conversation" | "stem" | undefined {
  if (input.conversationId && !input.conversationIdGenerated) {
    return input.hasConversationParks ? "conversation" : undefined;
  }
  if (input.conversationId && input.hasConversationParks) return "conversation";
  return input.hasStemParks ? "stem" : undefined;
}

export function filterToolsForChoice(
  tools: OpenAiToolFunction[] | undefined,
  toolChoice: ParsedChatRequest["tool_choice"],
): OpenAiToolFunction[] | undefined {
  if (typeof toolChoice !== "object") {
    return tools;
  }
  if (!tools || tools.length === 0) {
    throw invalidRequest(`tool_choice function '${toolChoice.name}' is not in tools`);
  }
  const selected = tools.find((tool) => tool.name === toolChoice.name);
  if (!selected) {
    throw invalidRequest(`tool_choice function '${toolChoice.name}' is not in tools`);
  }
  return [selected];
}

export function validateChatTurnRequest(request: ParsedChatRequest): ChatTurnKind {
  const turn = classifyChatTurn(request.messages);
  filterToolsForChoice(request.tools, request.tool_choice);
  return turn;
}

export function conversationKey(apiKeyId: string, conversationId: string): string {
  return `${apiKeyId}:conv:${conversationId}`;
}

/** 把进行中的会话挂到新的 response id 上，供 previous_response_id 续场。 */
export function aliasLiveConversation(
  apiKeyId: string,
  fromConversationId: string,
  toConversationId: string,
): boolean {
  if (fromConversationId === toConversationId) return false;
  const session = sessions.get(conversationKey(apiKeyId, fromConversationId));
  if (!session) return false;
  indexSession(session, apiKeyId, `conv:${toConversationId}`);
  return true;
}

export function claimConversationRequest(
  apiKeyId: string,
  conversationId: string | undefined,
): (() => void) | undefined {
  if (!conversationId) return undefined;
  const key = conversationKey(apiKeyId, conversationId);
  if (activeConversationRequests.has(key)) {
    throw conversationBusyError();
  }
  const claim = Symbol(key);
  activeConversationRequests.set(key, claim);
  return () => {
    if (activeConversationRequests.get(key) === claim) {
      activeConversationRequests.delete(key);
    }
  };
}

export async function withConversationClaim<T>(
  apiKeyId: string,
  conversationId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const releaseConversation = claimConversationRequest(apiKeyId, conversationId);
  try {
    return await operation();
  } finally {
    releaseConversation?.();
  }
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<CursorChatResult> {
  const turn = validateChatTurnRequest(options.request);
  return withConversationClaim(options.apiKeyId, options.request.conversation_id, async () => {
    let outputClaimed = false;
    const claimOutput = options.onClaimed
      ? async (): Promise<void> => {
          if (outputClaimed) return;
          outputClaimed = true;
          await options.onClaimed?.();
        }
      : undefined;
    return await runClaimedChatTurn({ ...options, claimOutput }, turn);
  });
}

async function runClaimedChatTurn(
  options: TurnOptions,
  turn: ChatTurnKind,
): Promise<CursorChatResult> {
  const lookupKey = sessionKey(options.apiKeyId, hashMessages(turn.stem));
  const conversationId = options.request.conversation_id;
  const convKey = conversationId ? conversationKey(options.apiKeyId, conversationId) : undefined;
  const byStem = sessions.get(lookupKey);
  const byConv = convKey ? sessions.get(convKey) : undefined;
  const parkedRoute = resolveParkedRoute({
    conversationId,
    conversationIdGenerated: options.request.conversation_id_generated,
    hasConversationParks: Boolean(byConv && byConv.parks.size > 0),
    hasStemParks: Boolean(byStem && byStem.parks.size > 0),
  });
  const parked = parkedRoute === "conversation" ? byConv : parkedRoute === "stem" ? byStem : undefined;
  const liveConv = byConv;
  if (turn.kind === "user" && liveConv && liveConv.parks.size > 0) {
    throw invalidRequest("Pending tool calls; send tool results before the next user message");
  }
  const storedConversation =
    options.db && conversationId
      ? getConversationMapping(options.db, options.apiKeyId, conversationId)
      : undefined;
  const action = resolveTurnAction({
    turn,
    hasParkedSession: Boolean(parked),
    conversationId,
    canResumeConversation: liveConv ? liveConv.parks.size === 0 : Boolean(storedConversation),
  });

  if (action === "continue_park" && turn.kind === "tool_results" && parked) {
    rememberConversation(parked, options);
    parked.sink = options.sink;
    parked.parkTimeoutMs = options.parkTimeoutMs ?? parked.parkTimeoutMs;
    applyToolResults(parked, turn.results);
    try {
      await options.claimOutput?.();
    } catch (error) {
      await dropSession(parked);
      throw error;
    }
    parked.lastRequestMessages = options.request.messages;
    indexSession(parked, options.apiKeyId, hashMessages(options.request.messages));
    const operation = async (): Promise<CursorChatResult> =>
      ensureSuccessfulRun(await continueRun(parked, options.abortSignal));
    return options.keyPool
      ? await options.keyPool.runForId(parked.cursorKeyId, async () => await operation())
      : await operation();
  }

  if (action === "replay_transcript") {
    logInfo("replaying tool results from transcript", {
      api_key_id: options.apiKeyId,
      conversation_id: conversationId ?? null,
    });
    return await startAgentSession(renderTranscript(options.request.messages), options);
  }

  if (action === "resume_user" && turn.kind === "user") {
    return await resumeUserTurn(turn, options, storedConversation);
  }

  if (turn.kind !== "user") {
    throw invalidRequest("Last message must be role 'user' or 'tool'");
  }
  return await startNewSession(turn, options);
}

async function resumeUserTurn(
  turn: Extract<ChatTurnKind, { kind: "user" }>,
  options: TurnOptions,
  stored: ConversationMapping | undefined,
): Promise<CursorChatResult> {
  if (!stored) {
    return await startNewSession(turn, options);
  }
  const pool = options.keyPool;
  if (!pool) {
    return await resumeUserTurnWithKey(turn, options, stored.agentId);
  }
  if (!stored.cursorKeyId && pool.size > 1) {
    if (turn.stem.length > 0) {
      logInfo("replaying legacy conversation with full transcript", {
        api_key_id: options.apiKeyId,
        conversation_id: options.request.conversation_id ?? null,
      });
      return await startNewSession(turn, options);
    }
    throw new GatewayError(
      409,
      "conversation_key_unknown",
      "This legacy conversation has no Cursor key owner; resend the full message history",
      "invalid_request_error",
    );
  }
  const ownerId = stored.cursorKeyId ?? pool.primaryId;
  let emitted = false;
  const sink = options.request.stream
    ? trackEmission(options.sink, () => {
        emitted = true;
      })
    : options.sink;
  try {
    return await pool.runForId(ownerId, async (apiKey) =>
      ensureSuccessfulRun(await resumeUserTurnWithKey(turn, { ...options, apiKey, sink }, stored.agentId)),
    );
  } catch (error) {
    if (turn.stem.length === 0 || emitted || options.abortSignal.aborted) throw error;
    logInfo("conversation resume failed, replaying full transcript", {
      api_key_id: options.apiKeyId,
      conversation_id: options.request.conversation_id ?? null,
      agent_id: stored.agentId,
      code: error instanceof GatewayError ? error.code : "upstream_error",
    });
    return await startNewSession(turn, options);
  }
}

async function resumeUserTurnWithKey(
  turn: Extract<ChatTurnKind, { kind: "user" }>,
  options: TurnOptions,
  storedAgentId: string,
): Promise<CursorChatResult> {
  const model = await resolveChatModel(options.apiKey, options.request);
  const releaseCapacity = await reserveSessionCapacity(options.apiKeyId);
  const session = emptySession(options, model.params, model.maxMode === true);
  const customTools = buildCustomTools(session, options.request.tools, options.request.tool_choice);
  try {
    session.agent = await resumeLocalChatAgent({
      agentId: storedAgentId,
      apiKey: options.apiKey,
      workspaceDir: options.workspaceDir,
      model,
      customTools,
      allowMaxMode: session.allowMaxMode,
    });
  } catch (error) {
    releaseCapacity();
    throw error;
  }
  session.maxMode = actualMaxMode(session.agent.model, session.maxMode);
  logInfo("resumed stored conversation", {
    api_key_id: options.apiKeyId,
    conversation_id: options.request.conversation_id ?? null,
    agent_id: storedAgentId,
  });
  try {
    // Claim (stream headers) only after the SDK-resolved max-mode check, so a 403 is still JSON.
    await options.claimOutput?.();
    rememberConversation(session, options);
  } catch (error) {
    await dropSession(session);
    throw error;
  } finally {
    releaseCapacity();
  }
  return await sendOnSession(session, turn.user.content, options);
}

async function startNewSession(
  turn: Extract<ChatTurnKind, { kind: "user" }>,
  options: TurnOptions,
): Promise<CursorChatResult> {
  const prompt =
    turn.stem.length === 0 ? turn.user.content : renderTranscript([...turn.stem, turn.user]);
  return await startAgentSession(prompt, options);
}

async function startAgentSession(prompt: string, options: TurnOptions): Promise<CursorChatResult> {
  const pool = options.keyPool;
  if (!pool) {
    return await startAgentSessionWithKey(prompt, options);
  }
  // Fail over only while nothing has reached the client; afterwards a retry would duplicate output.
  let emitted = false;
  const sink: ChatTurnSink | undefined = options.request.stream
    ? trackEmission(options.sink, () => {
        emitted = true;
      })
    : options.sink;
  return await pool.run(
    async (apiKey) => ensureSuccessfulRun(await startAgentSessionWithKey(prompt, { ...options, apiKey, sink })),
    () => !emitted && !options.abortSignal.aborted,
  );
}

async function startAgentSessionWithKey(prompt: string, options: TurnOptions): Promise<CursorChatResult> {
  const model = await resolveChatModel(options.apiKey, options.request);
  const releaseCapacity = await reserveSessionCapacity(options.apiKeyId);
  const session = emptySession(options, model.params, model.maxMode === true);
  const customTools = buildCustomTools(session, options.request.tools, options.request.tool_choice);
  try {
    session.agent = await createLocalChatAgent({
      apiKey: options.apiKey,
      workspaceDir: options.workspaceDir,
      model,
      customTools,
      allowMaxMode: session.allowMaxMode,
    });
  } catch (error) {
    releaseCapacity();
    throw mapCursorError(error);
  }
  session.maxMode = actualMaxMode(session.agent.model, session.maxMode);
  try {
    // Claim (stream headers) only after the SDK-resolved max-mode check, so a 403 is still JSON.
    await options.claimOutput?.();
    rememberConversation(session, options);
  } catch (error) {
    await dropSession(session);
    throw error;
  } finally {
    releaseCapacity();
  }
  return await sendOnSession(session, prompt, options);
}

function emptySession(
  options: {
    apiKey: string;
    apiKeyId: string;
    request: ParsedChatRequest;
    sink?: ChatTurnSink;
    parkTimeoutMs?: number;
  },
  modelParams: CursorChatResult["params"],
  maxMode = false,
): LiveSession {
  return {
    apiKeyId: options.apiKeyId,
    cursorKeyId: fingerprintKey(options.apiKey),
    agent: undefined as unknown as SDKAgent,
    run: undefined,
    waitPromise: undefined,
    parks: new Map(),
    batch: [],
    batchReady: undefined,
    lastFlushed: [],
    awaitingClient: false,
    flushTimer: undefined,
    parkTimer: undefined,
    indexKeys: [],
    modelParams,
    maxMode,
    allowMaxMode: maxModeAllowedFor(undefined),
    text: "",
    thinking: "",
    sink: options.sink,
    lastRequestMessages: options.request.messages,
    conversationId: options.request.conversation_id,
    parkTimeoutMs: options.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
}

function rememberConversation(
  session: LiveSession,
  options: { apiKeyId: string; request: ParsedChatRequest; db?: DatabaseSync },
): void {
  const conversationId = options.request.conversation_id;
  if (!conversationId || !session.agent) return;
  session.conversationId = conversationId;
  indexSession(session, options.apiKeyId, `conv:${conversationId}`);
  if (options.db) {
    upsertConversation(
      options.db,
      options.apiKeyId,
      conversationId,
      session.agent.agentId,
      session.cursorKeyId,
    );
  }
}

function ensureSuccessfulRun(result: CursorChatResult): CursorChatResult {
  if (result.status === "error" || result.finish_reason === "error") {
    throw runFailureError(result.error);
  }
  return result;
}

function trackEmission(sink: ChatTurnSink | undefined, mark: () => void): ChatTurnSink | undefined {
  if (!sink) return undefined;
  return {
    onText: async (text) => {
      if (text !== "") mark();
      await sink.onText(text);
    },
    onThinking: async (text) => {
      if (text !== "") mark();
      await sink.onThinking(text);
    },
    onToolCalls: async (calls) => {
      mark();
      await sink.onToolCalls(calls);
    },
  };
}

async function sendOnSession(
  session: LiveSession,
  prompt: string,
  options: {
    request: ParsedChatRequest;
    abortSignal: AbortSignal;
    sink?: ChatTurnSink;
  },
): Promise<CursorChatResult> {
  session.text = "";
  session.thinking = "";
  session.batch = [];
  session.lastFlushed = [];
  session.awaitingClient = false;
  session.batchReady = new Deferred<OpenAiToolCall[]>();
  session.sink = options.sink;
  session.lastRequestMessages = options.request.messages;
  session.lastActiveAt = Date.now();
  liveSessions.add(session);
  const customTools = buildCustomTools(session, options.request.tools, options.request.tool_choice);
  const images = imagesOfLastUser(options.request.messages);

  let run: Run;
  // Max mode disallowed: hold deltas while `send` resolves so nothing streams before the
  // run.model max-mode check. (Allowed: nothing to check, stream directly.)
  session.heldDeltas = session.allowMaxMode ? undefined : [];
  try {
    run = await session.agent.send(images && images.length > 0 ? { text: prompt, images } : prompt, {
      local: { ...(customTools ? { customTools } : {}), force: true },
      onDelta: async ({ update }) => {
        await emitDelta(session, update);
      },
    });
  } catch (error) {
    session.heldDeltas = undefined;
    await dropSession(session);
    throw mapCursorError(error);
  }
  if (run.model?.maxMode === true) {
    session.maxMode = true;
    if (!session.allowMaxMode) {
      // The SDK re-resolves the model on every send; never let a disallowed max run continue.
      logWarn("sdk sent a max-mode run although max mode is disallowed; cancelling", {
        api_key_id: session.apiKeyId,
        model: run.model.id,
      });
      // Keep holding (and discarding) deltas: the cancelled run may still emit some.
      session.heldDeltas = [];
      if (run.supports("cancel")) await run.cancel().catch(() => undefined);
      await dropSession(session);
      throw maxModeNotAllowed(run.model.id);
    }
  }
  await releaseHeldDeltas(session);
  session.run = run;
  session.waitPromise = settleRun(session, options.abortSignal);
  bindAbort(session, options.abortSignal);
  indexSession(session, session.apiKeyId, hashMessages(options.request.messages));
  return await raceTurn(session);
}

export async function continueRun(
  session: LiveSession,
  abortSignal: AbortSignal,
): Promise<CursorChatResult> {
  session.text = "";
  session.thinking = "";
  session.awaitingClient = false;
  session.lastFlushed = [];
  session.batchReady = new Deferred<OpenAiToolCall[]>();
  session.lastActiveAt = Date.now();
  clearParkTimer(session);
  bindAbort(session, abortSignal);
  if (session.batch.length > 0) {
    flushBatch(session);
  }
  return await raceTurn(session);
}

export async function raceTurn(session: LiveSession): Promise<CursorChatResult> {
  const waitPromise = session.waitPromise;
  const batchPromise = session.batchReady?.promise;
  if (!waitPromise) {
    throw new GatewayError(500, "server_error", "No active Cursor run", "server_error");
  }
  let outcome:
    | { kind: "done"; result: CursorChatResult }
    | { kind: "tools"; calls: OpenAiToolCall[] };
  try {
    outcome = await Promise.race([
      waitPromise.then((result) => ({ kind: "done" as const, result })),
      (batchPromise ?? neverSettle()).then((calls) => ({ kind: "tools" as const, calls })),
    ]);
  } catch (error) {
    await dropSession(session);
    throw error;
  }
  if (outcome.kind === "tools") {
    session.lastActiveAt = Date.now();
    armParkTimeout(session);
    indexSession(
      session,
      session.apiKeyId,
      hashMessages([
        ...session.lastRequestMessages,
        {
          role: "assistant",
          content: session.text,
          tool_calls: outcome.calls,
        },
      ]),
    );
    if (session.sink) await session.sink.onToolCalls(outcome.calls);
    return withThinking(session, {
      text: session.text,
      usage: toChatUsage(undefined),
      usageKnown: false,
      params: session.modelParams,
      ...(session.maxMode ? { max_mode: true } : {}),
      status: "finished",
      finish_reason: "tool_calls",
      tool_calls: outcome.calls,
    });
  }
  await dropSession(session);
  return withThinking(session, outcome.result);
}

export function applyToolResults(
  session: LiveSession,
  results: Array<{ toolCallId: string; content: string }>,
): void {
  const missing = missingFlushedToolResults(
    session.lastFlushed,
    results.map((result) => result.toolCallId),
  );
  if (missing.length > 0) {
    throw invalidRequest(`Missing tool results for: ${missing.join(", ")}`);
  }
  const received = new Set<string>();
  for (const result of results) {
    if (received.has(result.toolCallId)) {
      throw invalidRequest(`Duplicate tool_call_id '${result.toolCallId}'`);
    }
    received.add(result.toolCallId);
    if (!session.parks.has(result.toolCallId)) {
      throw invalidRequest(`Unknown tool_call_id '${result.toolCallId}'`);
    }
  }
  for (const result of results) {
    const parked = session.parks.get(result.toolCallId);
    if (!parked) {
      throw new GatewayError(500, "server_error", "Validated tool call disappeared", "server_error");
    }
    parked.resolve(result.content);
    session.parks.delete(result.toolCallId);
  }
}

function buildCustomTools(
  session: LiveSession,
  tools: OpenAiToolFunction[] | undefined,
  toolChoice: ParsedChatRequest["tool_choice"],
): Record<string, SDKCustomTool> | undefined {
  if (toolChoice === "none") return undefined;
  const selected = filterToolsForChoice(tools, toolChoice);
  if (!selected || selected.length === 0) return undefined;
  const custom: Record<string, SDKCustomTool> = {};
  for (const tool of selected) {
    custom[tool.name] = {
      description: tool.description ?? "",
      inputSchema: tool.parameters as Record<string, SDKJsonValue>,
      execute: async (args, context) => parkTool(session, tool, args, context.toolCallId),
    };
  }
  return custom;
}

function parkTool(
  session: LiveSession,
  tool: OpenAiToolFunction,
  args: Record<string, SDKJsonValue>,
  toolCallId: string | undefined,
): Promise<string> {
  const id = toOpenAiToolCallId(toolCallId);
  logInfo("parked client tool call", { name: tool.name, api_key_id: session.apiKeyId });
  session.batch.push({
    id,
    name: tool.name,
    arguments: JSON.stringify(args),
  });
  if (!session.awaitingClient) {
    scheduleFlush(session);
  }
  return new Promise<string>((resolve, reject) => {
    session.parks.set(id, { resolve, reject });
  });
}

const FLUSH_DEBOUNCE_MS = 50;

function scheduleFlush(session: LiveSession): void {
  if (session.flushTimer !== undefined) return;
  session.flushTimer = setTimeout(() => {
    session.flushTimer = undefined;
    flushBatch(session);
  }, FLUSH_DEBOUNCE_MS);
}

function flushBatch(session: LiveSession): void {
  if (session.flushTimer !== undefined) {
    clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
  }
  if (session.batch.length === 0) return;
  const calls = session.batch;
  session.batch = [];
  session.lastFlushed = calls.map((call) => call.id);
  session.awaitingClient = true;
  session.batchReady?.resolve(calls);
}

async function emitDelta(session: LiveSession, update: InteractionUpdate): Promise<void> {
  if (session.heldDeltas) {
    session.heldDeltas.push(update);
    return;
  }
  await deliverDelta(session, update);
}

/** Replays held deltas in order (new ones keep queueing meanwhile), then streams directly. */
async function releaseHeldDeltas(session: LiveSession): Promise<void> {
  const held = session.heldDeltas;
  if (!held) return;
  while (held.length > 0) {
    const update = held.shift() as InteractionUpdate;
    await deliverDelta(session, update);
  }
  session.heldDeltas = undefined;
}

async function deliverDelta(session: LiveSession, update: InteractionUpdate): Promise<void> {
  if (update.type === "thinking-delta") {
    if (update.text === "") return;
    session.thinking += update.text;
    if (session.sink) await session.sink.onThinking(update.text);
    return;
  }
  if (update.type !== "text-delta") return;
  if (update.text === "") return;
  session.text += update.text;
  if (session.sink) await session.sink.onText(update.text);
}

function withThinking(session: LiveSession, result: CursorChatResult): CursorChatResult {
  if (session.thinking.length === 0) return result;
  return { ...result, reasoning: session.thinking };
}

async function settleRun(session: LiveSession, abortSignal: AbortSignal): Promise<CursorChatResult> {
  const run = session.run;
  if (!run) {
    return {
      text: "",
      usage: toChatUsage(undefined),
      usageKnown: false,
      status: "error",
      finish_reason: "error",
    };
  }
  try {
    if (abortSignal.aborted && run.supports("cancel")) {
      await run.cancel();
    }
    const result = await run.wait();
    const billed = await billedUsageOf(session.agent);
    const rawUsage = result.usage ?? billed?.usage;
    if (result.status === "cancelled") {
      return {
        text: session.text,
        usage: toChatUsage(undefined),
        usageKnown: false,
        status: "cancelled",
        finish_reason: "cancelled",
        params: session.modelParams,
        ...(session.maxMode ? { max_mode: true } : {}),
      };
    }
    if (result.status === "error") {
      return {
        ...(result.error ? { error: { message: result.error.message, code: result.error.code } } : {}),
        text: session.text,
        usage: toChatUsage(rawUsage),
        usageKnown: rawUsage !== undefined,
        status: "error",
        finish_reason: "error",
        params: session.modelParams,
        ...(session.maxMode ? { max_mode: true } : {}),
      };
    }
    return {
      text: result.result ?? session.text,
      usage: toChatUsage(rawUsage),
      usageKnown: rawUsage !== undefined,
      cost: billed?.cost
        ? { raw_cost_cents: billed.cost.rawCostCents, charged_cents: billed.cost.chargedCents }
        : null,
      params: session.modelParams,
      ...(session.maxMode ? { max_mode: true } : {}),
      status: "finished",
      finish_reason: "stop",
    };
  } catch (error) {
    if (abortSignal.aborted) {
      return {
        text: session.text,
        usage: toChatUsage(undefined),
        usageKnown: false,
        status: "cancelled",
        finish_reason: "cancelled",
        params: session.modelParams,
        ...(session.maxMode ? { max_mode: true } : {}),
      };
    }
    throw mapCursorError(error);
  }
}

function bindAbort(session: LiveSession, abortSignal: AbortSignal): void {
  const onAbort = (): void => {
    if (session.parks.size > 0) return;
    if (session.run?.supports("cancel")) {
      void session.run.cancel();
    }
  };
  if (abortSignal.aborted) onAbort();
  else abortSignal.addEventListener("abort", onAbort, { once: true });
}

function armParkTimeout(session: LiveSession): void {
  clearParkTimer(session);
  session.parkTimer = setTimeout(() => {
    logInfo("pending tool calls timed out", { api_key_id: session.apiKeyId });
    for (const parked of session.parks.values()) {
      parked.reject(new Error("Timed out waiting for tool results"));
    }
    session.parks.clear();
    void dropSession(session);
  }, session.parkTimeoutMs);
}

function clearParkTimer(session: LiveSession): void {
  if (session.parkTimer) {
    clearTimeout(session.parkTimer);
    session.parkTimer = undefined;
  }
}

function sessionKey(apiKeyId: string, hash: string): string {
  return `${apiKeyId}:${hash}`;
}

function indexSession(session: LiveSession, apiKeyId: string, hash: string): void {
  const key = sessionKey(apiKeyId, hash);
  const prev = sessions.get(key);
  if (prev && prev !== session && prev.parks.size > 0) {
    return;
  }
  if (prev && prev !== session) {
    prev.indexKeys = prev.indexKeys.filter((item) => item !== key);
  }
  sessions.set(key, session);
  if (!session.indexKeys.includes(key)) session.indexKeys.push(key);
}

async function dropSession(session: LiveSession): Promise<void> {
  liveSessions.delete(session);
  clearParkTimer(session);
  if (session.flushTimer) clearTimeout(session.flushTimer);
  for (const key of session.indexKeys) {
    if (sessions.get(key) === session) sessions.delete(key);
  }
  session.indexKeys = [];
  for (const parked of session.parks.values()) {
    parked.reject(new Error("Session closed"));
  }
  session.parks.clear();
  await disposeAgent(session.agent);
}

function neverSettle(): Promise<never> {
  return new Promise(() => undefined);
}
