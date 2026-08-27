import { createHash, randomUUID } from "node:crypto";
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
  ParsedImage,
} from "./contracts.js";
import {
  billedUsageOf,
  createLocalChatAgent,
  disposeAgent,
  mapCursorError,
  resolveChatModel,
  toChatUsage,
} from "./cursor.js";
import { GatewayError, invalidRequest } from "./errors.js";
import { logInfo } from "./log.js";
import { renderTranscript } from "./openai.js";

const PARK_TIMEOUT_MS = 5 * 60 * 1000;

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
  onToolCalls(calls: OpenAiToolCall[]): Promise<void>;
}

interface ParkedCall {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

interface LiveSession {
  apiKeyId: string;
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
  text: string;
  sink: ChatTurnSink | undefined;
  lastRequestMessages: ParsedChatMessage[];
}

const sessions = new Map<string, LiveSession>();

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
export function missingFlushedToolResults(flushedIds: string[], receivedIds: string[]): string[] {
  const got = new Set(receivedIds);
  return flushedIds.filter((id) => !got.has(id));
}

export function hashMessages(messages: ParsedChatMessage[]): string {
  const payload = messages.map((message) => {
    const row: Record<string, unknown> = { role: message.role, content: message.content };
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

export async function runChatTurn(options: {
  apiKey: string;
  apiKeyId: string;
  workspaceDir: string;
  request: ParsedChatRequest;
  abortSignal: AbortSignal;
  sink?: ChatTurnSink;
}): Promise<CursorChatResult> {
  const turn = classifyChatTurn(options.request.messages);
  const lookupKey = sessionKey(options.apiKeyId, hashMessages(turn.stem));

  if (turn.kind === "tool_results") {
    const session = sessions.get(lookupKey);
    if (!session || session.parks.size === 0) {
      throw invalidRequest("No pending tool calls for this conversation");
    }
    session.sink = options.sink;
    applyToolResults(session, turn.results);
    session.lastRequestMessages = options.request.messages;
    indexSession(session, options.apiKeyId, hashMessages(options.request.messages));
    return await continueRun(session, options.abortSignal);
  }

  // User turns always start a fresh Cursor agent from the HTTP transcript.
  // Reusing an idle agent by stem hash mixes OpenCode sessions that share a
  // prefix: lookup ignores the new user line, and agent.send only gets that line.
  return await startNewSession(turn, options);
}

async function startNewSession(
  turn: Extract<ChatTurnKind, { kind: "user" }>,
  options: {
    apiKey: string;
    apiKeyId: string;
    workspaceDir: string;
    request: ParsedChatRequest;
    abortSignal: AbortSignal;
    sink?: ChatTurnSink;
  },
): Promise<CursorChatResult> {
  const model = await resolveChatModel(options.apiKey, options.request);
  const session: LiveSession = {
    apiKeyId: options.apiKeyId,
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
    modelParams: model.params,
    text: "",
    sink: options.sink,
    lastRequestMessages: options.request.messages,
  };
  const customTools = buildCustomTools(session, options.request.tools, options.request.tool_choice);
  try {
    session.agent = await createLocalChatAgent({
      apiKey: options.apiKey,
      workspaceDir: options.workspaceDir,
      model,
      customTools,
    });
  } catch (error) {
    throw mapCursorError(error);
  }
  const prompt =
    turn.stem.length === 0 ? turn.user.content : renderTranscript([...turn.stem, turn.user]);
  return await sendOnSession(session, prompt, options);
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
  session.batch = [];
  session.lastFlushed = [];
  session.awaitingClient = false;
  session.batchReady = new Deferred<OpenAiToolCall[]>();
  session.sink = options.sink;
  session.lastRequestMessages = options.request.messages;
  const customTools = buildCustomTools(session, options.request.tools, options.request.tool_choice);
  const images = options.request.images;

  let run: Run;
  try {
    run = await session.agent.send(images && images.length > 0 ? { text: prompt, images } : prompt, {
      local: { ...(customTools ? { customTools } : {}), force: true },
      onDelta: async ({ update }) => {
        await emitDelta(session, update);
      },
    });
  } catch (error) {
    await dropSession(session);
    throw mapCursorError(error);
  }
  session.run = run;
  session.waitPromise = settleRun(session, options.abortSignal);
  bindAbort(session, options.abortSignal);
  indexSession(session, session.apiKeyId, hashMessages(options.request.messages));
  return await raceTurn(session);
}

async function continueRun(session: LiveSession, abortSignal: AbortSignal): Promise<CursorChatResult> {
  session.awaitingClient = false;
  session.lastFlushed = [];
  session.batchReady = new Deferred<OpenAiToolCall[]>();
  clearParkTimer(session);
  bindAbort(session, abortSignal);
  if (session.batch.length > 0) {
    flushBatch(session);
  }
  return await raceTurn(session);
}

async function raceTurn(session: LiveSession): Promise<CursorChatResult> {
  const waitPromise = session.waitPromise;
  const batchPromise = session.batchReady?.promise;
  if (!waitPromise) {
    throw new GatewayError(500, "server_error", "No active Cursor run", "server_error");
  }
  const outcome = await Promise.race([
    waitPromise.then((result) => ({ kind: "done" as const, result })),
    (batchPromise ?? neverSettle()).then((calls) => ({ kind: "tools" as const, calls })),
  ]);
  if (outcome.kind === "tools") {
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
    return {
      text: session.text,
      usage: toChatUsage(undefined),
      usageKnown: false,
      params: session.modelParams,
      status: "finished",
      finish_reason: "tool_calls",
      tool_calls: outcome.calls,
    };
  }
  await dropSession(session);
  return outcome.result;
}

function applyToolResults(
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
  for (const result of results) {
    const parked = session.parks.get(result.toolCallId);
    if (!parked) {
      throw invalidRequest(`Unknown tool_call_id '${result.toolCallId}'`);
    }
    parked.resolve(result.content);
    session.parks.delete(result.toolCallId);
  }
}

function buildCustomTools(
  session: LiveSession,
  tools: OpenAiToolFunction[] | undefined,
  toolChoice: "auto" | "none" | undefined,
): Record<string, SDKCustomTool> | undefined {
  if (toolChoice === "none") return undefined;
  if (!tools || tools.length === 0) return undefined;
  const custom: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
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
  if (update.type !== "text-delta") return;
  if (update.text === "") return;
  session.text += update.text;
  if (session.sink) await session.sink.onText(update.text);
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
      };
    }
    if (result.status === "error") {
      return {
        text: session.text,
        usage: toChatUsage(rawUsage),
        usageKnown: rawUsage !== undefined,
        status: "error",
        finish_reason: "error",
        params: session.modelParams,
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
  }, PARK_TIMEOUT_MS);
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
