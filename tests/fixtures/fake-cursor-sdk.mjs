import { appendFileSync } from "node:fs";
// In-process stand-in for @cursor/sdk used by the HTTP integration tests.
// Behavior is driven by markers in the prompt text so tests need no Cursor credentials.

export class CursorSdkError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.isRetryable = options.isRetryable ?? false;
  }
}
export class CursorAgentError extends CursorSdkError {}
export class AuthenticationError extends CursorAgentError {
  constructor(message, options = {}) {
    super(message, { status: 401, ...options });
  }
}
export class RateLimitError extends CursorAgentError {
  constructor(message, options = {}) {
    super(message, { status: 429, ...options });
  }
}
export class NetworkError extends CursorAgentError {}
export class AgentBusyError extends CursorAgentError {
  constructor(message, options = {}) {
    super(message, { status: 409, ...options });
  }
}
export class ConfigurationError extends CursorAgentError {
  constructor(message, options = {}) {
    super(message, { status: 400, ...options });
  }
}

const CATALOG = [
  { id: "fake-model", displayName: "Fake Model", aliases: ["fake-alias"], parameters: [], variants: [] },
  {
    id: "fake-reasoner",
    displayName: "Fake Reasoner",
    parameters: [
      {
        id: "reasoning_effort",
        displayName: "Reasoning effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      },
    ],
    variants: [
      { displayName: "Fake Reasoner", isDefault: true, params: [{ id: "reasoning_effort", value: "medium" }] },
      { displayName: "Fake Reasoner High", params: [{ id: "reasoning_effort", value: "high" }] },
    ],
  },
  {
    // Shaped like grok-4.7: the DEFAULT variant is max-only (1m context); 200k variants are not.
    id: "fake-max",
    displayName: "Fake Max",
    aliases: ["fake-max-alias"],
    parameters: [
      { id: "context", values: [{ value: "200k" }, { value: "1m" }] },
      { id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }, { value: "max" }] },
    ],
    variants: [
      { displayName: "Fake Max Low", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "low" }] },
      { displayName: "Fake Max High", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "high" }] },
      { displayName: "Fake Max 1M High", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }] },
      { displayName: "Max", isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "max" }] },
    ],
  },
  {
    id: "fake-maxonly",
    displayName: "Fake Max Only",
    parameters: [{ id: "context", values: [{ value: "1m" }] }],
    variants: [{ displayName: "Fake Max Only", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }] }],
  },
];

/** Mirrors the @cursor/sdk 1.0.38 local rule: explicit maxMode, else params non-empty and every matching variant is max-only. */
function sdkMaxMode(model) {
  if (!model) return false;
  if (model.maxMode === true) return true;
  const params = model.params ?? [];
  if (params.length === 0) return false;
  const item = CATALOG.find((entry) => entry.id === model.id);
  const matching = (item?.variants ?? []).filter((variant) =>
    params.every((param) => variant.params.some((own) => own.id.trim() === param.id.trim() && own.value.trim() === param.value.trim())),
  );
  return matching.length > 0 && matching.every((variant) => variant.isMaxMode === true);
}

/**
 * What the real SDK exposes as `agent.model` / `run.model`: the selection resolved against ITS
 * catalog. FAKE_SDK_FORCE_MAX=agent|run simulates an SDK catalog that disagrees with the gateway.
 */
function resolvedModel(model, stage, resumed = false) {
  if (!model) return undefined;
  // FAKE_SDK_FORCE_MAX=run-resumed: only runs of resumed agents flip to max (resume-path recheck).
  const forced = process.env.FAKE_SDK_FORCE_MAX === stage || (process.env.FAKE_SDK_FORCE_MAX === "run-resumed" && stage === "run" && resumed);
  return forced || sdkMaxMode(model) ? { ...model, maxMode: true } : model;
}

function catalogForKey(apiKey) {
  if (apiKey.startsWith("model-a-")) return [{ ...CATALOG[0], id: "fake-model-a", aliases: [] }];
  if (apiKey.startsWith("model-b-")) return [{ ...CATALOG[0], id: "fake-model-b", aliases: [] }];
  return CATALOG;
}

/** Keys starting with these prefixes simulate upstream failures. */
function checkKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.startsWith("bad-")) {
    throw new AuthenticationError("invalid key");
  }
  if (apiKey.startsWith("limited-")) {
    throw new RateLimitError("usage limit exceeded");
  }
}

export const calls = { create: [], resume: [], send: [], disposed: [] };
globalThis.__fakeCursorCalls = calls;

/** FAKE_SDK_LEDGER=<file>: one JSON line per create / resume / dispatch / cancel / dispose (cross-process asserts). */
function ledger(event) {
  if (process.env.FAKE_SDK_LEDGER) appendFileSync(process.env.FAKE_SDK_LEDGER, `${JSON.stringify(event)}\n`);
}

export const Cursor = {
  models: {
    async list({ apiKey }) {
      checkKey(apiKey);
      return catalogForKey(apiKey);
    },
  },
  async me({ apiKey }) {
    checkKey(apiKey);
    return { apiKeyName: "fake", createdAt: "2026-01-01T00:00:00Z", userId: "u1" };
  },
};

let agentSeq = 0;
const agentOwners = new Map();

function makeAgent(apiKey, agentId, model, resumed = false) {
  return {
    agentId,
    apiKey,
    get model() {
      return resolvedModel(model, "agent");
    },
    async send(message, options = {}) {
      checkKey(apiKey);
      const prompt = typeof message === "string" ? message : message.text;
      calls.send.push({ apiKey, agentId, prompt });
      if (process.env.FAKE_SDK_DEBUG) process.stderr.write(`fake-sdk send: tools=${Object.keys(options.local?.customTools ?? {}).join(",")} tail=${JSON.stringify(prompt.slice(-300))}\n`);
      if (process.env.FAKE_SDK_DELAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SDK_DELAY_MS)));
      }
      if (prompt.includes("FAIL_RATE_LIMIT")) {
        throw new RateLimitError("usage limit exceeded");
      }
      if (prompt.includes("FAIL_NETWORK")) {
        throw new NetworkError("connect ECONNREFUSED", { isRetryable: true, requestId: "req-net-1" });
      }
      let text = "";
      let status = "finished";
      let runError;
      const emit = async (update) => {
        await options.onDelta?.({ update });
      };
      const runModel = resolvedModel(model, "run", resumed);
      ledger({ event: "dispatch", agentId, maxMode: runModel?.maxMode === true });
      // FAKE_SDK_EARLY_DELTA=1: like the real SDK, text can arrive before `send` returns the Run.
      if (process.env.FAKE_SDK_EARLY_DELTA === "1") await emit({ type: "text-delta", text: "EARLY_LEAK" });
      const work = (async () => {
        // `THINK<<N>>` streams N characters of thinking instead of "pondering".
        const think = /THINK<<(\d+)>>/.exec(prompt);
        await emit({ type: "thinking-delta", text: think ? "t".repeat(Number(think[1])) : "pondering" });
        const tools = options.local?.customTools ?? {};
        const names = Object.keys(tools);
        // `CALL_TOOL<<Name|{"json":"args"}>>` calls a specific client tool.
        const named = /CALL_TOOL<<([A-Za-z0-9_.-]+)\|(\{.*?\})>>/s.exec(prompt);
        if (named && tools[named[1]] && !/\[tool call_/.test(prompt)) {
          const result = await tools[named[1]].execute(JSON.parse(named[2]), { toolCallId: `tool-${named[1]}` });
          text = `tool said: ${result}`;
          await emit({ type: "text-delta", text });
          return;
        }
        if (prompt.includes("ECHO_MODEL")) {
          text = JSON.stringify(model ?? null);
          await emit({ type: "text-delta", text });
          return;
        }
        // Reports what the SDK would send upstream (selection + resolved max mode).
        if (prompt.includes("ECHO_MAX")) {
          text = JSON.stringify({ id: model?.id ?? null, params: model?.params ?? [], sdk_max_mode: sdkMaxMode(model) });
          await emit({ type: "text-delta", text });
          return;
        }
        // Fake keys only (never real ones): lets e2e tests assert which pool key served the run.
        if (prompt.includes("ECHO_KEY")) {
          text = apiKey;
          await emit({ type: "text-delta", text });
          return;
        }
        // `SAY<<text>>` streams `text` in 3-char deltas and stops once the run is cancelled.
        const say = /SAY<<([\s\S]*?)>>/.exec(prompt);
        if (say) {
          for (let index = 0; index < say[1].length; index += 3) {
            if (status === "cancelled") return;
            const part = say[1].slice(index, index + 3);
            text += part;
            await emit({ type: "text-delta", text: part });
            await new Promise((resolve) => setImmediate(resolve));
          }
          return;
        }
        // Echoes the end of the prompt actually sent upstream (e.g. the JSON-mode instruction).
        if (prompt.includes("ECHO_PROMPT_TAIL")) {
          text = prompt.slice(-600);
          await emit({ type: "text-delta", text });
          return;
        }
        if (prompt.includes("ECHO_AGENT")) {
          text = agentId;
          await emit({ type: "text-delta", text });
          return;
        }
        if (prompt.includes("CALL_TOOL") && names.length > 0) {
          const result = await tools[names[0]].execute({ query: "weather" }, { toolCallId: "tool-1" });
          text = `tool said: ${result}`;
          await emit({ type: "text-delta", text });
          return;
        }
        // Slow stream (40 x 50 ms) that stops once cancelled: lets tests abort mid-run.
        if (prompt.includes("SLOW_STREAM")) {
          for (let index = 0; index < 40; index += 1) {
            if (status === "cancelled") return;
            text += "chunk ";
            await emit({ type: "text-delta", text: "chunk " });
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return;
        }
        if (prompt.includes("UPSTREAM_ERROR")) {
          status = "error";
          runError = { message: "model backend unavailable", code: "unavailable" };
          return;
        }
        if (prompt.includes("RUN_QUOTA")) {
          status = "error";
          runError = { message: "You have reached your usage limit", code: "resource_exhausted" };
          return;
        }
        for (const part of ["PO", "NG"]) {
          text += part;
          await emit({ type: "text-delta", text: part });
        }
      })();
      return {
        model: runModel,
        supports: () => true,
        async cancel() {
          // `IGNORE_CANCEL`: the run keeps going and finishes normally (cancel raced with the end).
          if (!prompt.includes("IGNORE_CANCEL")) status = "cancelled";
          calls.cancelled = (calls.cancelled ?? 0) + 1;
          ledger({ event: "cancel", agentId });
        },
        async wait() {
          await work;
          // `THROW_ON_CANCEL`: wait() rejects once the run was cancelled.
          if (status === "cancelled" && prompt.includes("THROW_ON_CANCEL")) throw new Error("run stream closed after cancel");
          return {
            status,
            result: status === "finished" ? text : undefined,
            ...(runError ? { error: runError } : {}),
            // FAKE_SDK_NO_USAGE_ON_CANCEL=1: a cancelled run reports no usage (forces the estimate path).
            // FAKE_SDK_ZERO_USAGE_ON_CANCEL=1: a cancelled run reports all-zero usage.
            // FAKE_SDK_RUN_TOKENS=N: every run reports N total tokens (N - 2 input, 2 output).
            ...(status === "cancelled" && process.env.FAKE_SDK_NO_USAGE_ON_CANCEL === "1"
              ? {}
              : status === "cancelled" && process.env.FAKE_SDK_ZERO_USAGE_ON_CANCEL === "1"
                ? { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
                : process.env.FAKE_SDK_RUN_TOKENS
                  ? { usage: { inputTokens: Number(process.env.FAKE_SDK_RUN_TOKENS) - 2, outputTokens: 2, totalTokens: Number(process.env.FAKE_SDK_RUN_TOKENS), cacheReadTokens: 0, cacheWriteTokens: 0 } }
                  : { usage: { inputTokens: 11, outputTokens: 2, totalTokens: 16, cacheReadTokens: 3, cacheWriteTokens: 0 } }),
          };
        },
      };
    },
    async getUsage() {
      return undefined;
    },
    close() { calls.disposed.push(agentId); ledger({ event: "dispose", agentId }); },
    async [Symbol.asyncDispose]() { calls.disposed.push(agentId); ledger({ event: "dispose", agentId }); },
  };
}

export const Agent = {
  async create(options) {
    checkKey(options.apiKey);
    agentSeq += 1;
    calls.create.push({ apiKey: options.apiKey, model: options.model, sdkMaxMode: sdkMaxMode(options.model) });
    const agentId = `agent-${String(agentSeq)}`;
    agentOwners.set(agentId, options.apiKey);
    ledger({ event: "create", agentId });
    return makeAgent(options.apiKey, agentId, options.model);
  },
  async resume(agentId, options) {
    checkKey(options.apiKey);
    const owner = agentOwners.get(agentId);
    if (owner !== undefined && owner !== options.apiKey) {
      throw new AuthenticationError("agent belongs to another Cursor key");
    }
    if (process.env.FAKE_SDK_FAIL_RESUME === "1") {
      throw new NetworkError("resume failed", { isRetryable: true, requestId: "req-resume-1" });
    }
    calls.resume.push({ agentId, model: options.model, sdkMaxMode: sdkMaxMode(options.model) });
    ledger({ event: "resume", agentId });
    return makeAgent(options.apiKey, agentId, options.model, true);
  },
};
