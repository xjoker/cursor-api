// #42 review round 1 (Elliot): thinking always counted toward the quota estimate (#1), JSON-mode
// instruction counted (#2), tool-result continuations use their own output shaping (#3), mutant
// kills for the truncation paths (#4) and the lows (#5-#8). Offline (fake SDK).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QUOTA_RESERVE_OUTPUT_TOKENS, reservationFor } from "../dist/key-policy.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { OutputLimiter } from "../dist/output-limits.js";
import { clearStoredResponses, getStoredResponse, MAX_STORED_RESPONSES_PER_KEY, storeResponse } from "../dist/response-store.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const ADMIN = { authorization: "Bearer it-admin-key", "content-type": "application/json" };
const HEADERS = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const TOOLS = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
const QUOTA = { keyPolicy: { quota_tokens: 1_000_000 } };
const post = (gateway, path, body, init = {}) =>
  fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body), ...init });
const chat = (gateway, body) => post(gateway, "/v1/chat/completions", { model: "fake-model", ...body });
const user = (content) => [{ role: "user", content }];

async function usageOf(gateway) {
  const res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage`, { headers: ADMIN });
  return (await res.json()).current;
}

async function resetUsage(gateway) {
  const res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage/reset`, { method: "POST", headers: ADMIN });
  assert.equal(res.status, 200);
}

async function waitFor(check, label, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs one request from a zeroed usage row and returns [response body, tokens charged]. */
async function charged(gateway, body) {
  await resetUsage(gateway);
  const res = await chat(gateway, body);
  assert.equal(res.status, 200);
  const json = await res.json();
  const usage = await waitFor(async () => {
    const current = await usageOf(gateway);
    return current.in_flight === 0 ? current : undefined;
  }, "request settled");
  return [json, usage.tokens];
}

function withLedger(run) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-api-r42-ledger-"));
  const file = join(dir, "ledger.jsonl");
  const events = () => {
    try {
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return Promise.resolve(run(file, events)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// --- #1 thinking is charged even with reasoning.exclude ------------------------------------------

test("#1: reasoning.exclude hides thinking from the client but not from the quota estimate", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true", FAKE_SDK_NO_USAGE_ON_CANCEL: "1" }, QUOTA);
  try {
    // Truncation path (cut + cancel, no upstream usage): the estimate is the charge.
    const body = { max_tokens: 1, messages: user("THINK<<40000>> SAY<<hello world>>") };
    const [shown, full] = await charged(gateway, body);
    const [hidden, excluded] = await charged(gateway, { ...body, reasoning: { exclude: true } });
    assert.equal(shown.choices[0].message.reasoning_content.length, 40_000);
    assert.equal(hidden.choices[0].message.reasoning_content, undefined, "exclude still hides it");
    assert.ok(full >= 10_000, String(full));
    assert.equal(excluded, full, "exclude does not change the charge");

    // Suspended tool round (precharged at suspension, maybe never resumed).
    const [parked, precharged] = await charged(gateway, { tools: TOOLS, reasoning: { exclude: true }, messages: user("CALL_TOOL THINK<<40000>>") });
    assert.equal(parked.choices[0].finish_reason, "tool_calls");
    assert.ok(precharged >= 10_000, `parked round precharge ${String(precharged)}`);
  } finally {
    await gateway.stop();
  }
});

// --- #2 JSON-mode instruction is counted ----------------------------------------------------------

test("#2 unit: the admission reservation includes the JSON-mode instruction and schema", () => {
  const messages = user("hi");
  const schema = { type: "object", description: "x".repeat(40_000) };
  assert.equal(reservationFor({ messages }), 1 + QUOTA_RESERVE_OUTPUT_TOKENS);
  const withSchema = reservationFor({ messages, output_format: { type: "json_schema", name: "a", schema } });
  assert.ok(withSchema >= 10_000 + QUOTA_RESERVE_OUTPUT_TOKENS, String(withSchema));
  assert.ok(reservationFor({ messages, output_format: { type: "json_object" } }) > 1 + QUOTA_RESERVE_OUTPUT_TOKENS);
});

test("#2 e2e: a large json_schema is charged on the estimate path and reserved at admission", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true", FAKE_SDK_NO_USAGE_ON_CANCEL: "1" }, QUOTA);
  const response_format = { type: "json_schema", json_schema: { name: "a", schema: { type: "object", description: "x".repeat(40_000) } } };
  try {
    const [, plain] = await charged(gateway, { max_tokens: 1, messages: user('SAY<<{"a":1}>>') });
    const [, schemaCharge] = await charged(gateway, { max_tokens: 1, response_format, messages: user('SAY<<{"a":1}>>') });
    assert.ok(plain < 100, String(plain));
    assert.ok(schemaCharge >= 10_000, `schema counted: ${String(schemaCharge)}`);

    await resetUsage(gateway);
    const controller = new AbortController();
    const pending = chat(gateway, { response_format, messages: user("SLOW_STREAM") }, { signal: controller.signal });
    const inFlight = await waitFor(async () => {
      const current = await usageOf(gateway);
      return current.in_flight === 1 ? current : undefined;
    }, "request admitted");
    assert.ok(inFlight.tokens >= 10_000 + QUOTA_RESERVE_OUTPUT_TOKENS, `reserved ${String(inFlight.tokens)}`);
    controller.abort();
    await pending.then((res) => res.text()).catch(() => undefined);
    await waitFor(async () => (await usageOf(gateway)).in_flight === 0, "aborted request settled");
  } finally {
    await gateway.stop();
  }
});

// --- #3 continuation turns use their own output shaping -------------------------------------------

test("#3: a tool-result continuation uses its own max_tokens / stop, not the first turn's", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true" });
  const round = async (tag, first, second) => {
    const messages = user(`CALL_TOOL ${tag}`);
    let res = await chat(gateway, { tools: TOOLS, messages, ...first });
    const parked = await res.json();
    assert.equal(parked.choices[0].finish_reason, "tool_calls", tag);
    const call = parked.choices[0].message.tool_calls[0];
    res = await chat(gateway, {
      tools: TOOLS,
      messages: [...messages, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "sunny" }],
      ...second,
    });
    assert.equal(res.status, 200, tag);
    return (await res.json()).choices[0];
  };
  try {
    let choice = await round("a", { max_tokens: 1 }, {});
    assert.equal(choice.message.content, "tool said: sunny", "first turn's max_tokens not applied to the continuation");
    assert.equal(choice.finish_reason, "stop");

    choice = await round("b", {}, { max_tokens: 1 });
    assert.equal(choice.message.content, "tool", "continuation's own max_tokens applies");
    assert.equal(choice.finish_reason, "length");

    choice = await round("c", { stop: "sunny" }, { stop: "said" });
    assert.equal(choice.message.content, "tool ", "continuation's own stop applies");
    assert.equal(choice.finish_reason, "stop");
  } finally {
    await gateway.stop();
  }
});

// --- #4 mutant kills on the truncation paths ------------------------------------------------------

test("#4: truncation paths charge the estimate (not the reservation) and cancel the upstream run", { timeout: 30_000 }, async () => {
  await withLedger(async (ledgerFile, events) => {
    const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true", FAKE_SDK_NO_USAGE_ON_CANCEL: "1", FAKE_SDK_LEDGER: ledgerFile }, QUOTA);
    try {
      // Cancelled branch of settleRun.
      let [body, tokens] = await charged(gateway, { max_tokens: 1, messages: user("SAY<<hello world>>") });
      assert.equal(body.choices[0].message.content, "hell");
      assert.equal(body.choices[0].finish_reason, "length");
      assert.ok(tokens > 0 && tokens < QUOTA_RESERVE_OUTPUT_TOKENS, `estimate, not the reservation: ${String(tokens)}`);
      assert.equal(events().filter((event) => event.event === "cancel").length, 1, "the upstream run was cancelled");

      // wait() rejects after the cut (catch branch of settleRun).
      [body, tokens] = await charged(gateway, { max_tokens: 1, messages: user("THROW_ON_CANCEL SAY<<hello world>>") });
      assert.equal(body.choices[0].message.content, "hell");
      assert.equal(body.choices[0].finish_reason, "length");
      assert.ok(tokens > 0 && tokens < QUOTA_RESERVE_OUTPUT_TOKENS, `catch branch estimate: ${String(tokens)}`);
      assert.equal(events().filter((event) => event.event === "cancel").length, 2);
    } finally {
      await gateway.stop();
    }
  });
});

test("#4: a run that still finishes after the cut never returns the untruncated upstream text", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true" });
  try {
    let res = await chat(gateway, { stop: "STOP", messages: user("IGNORE_CANCEL SAY<<hello STOP world>>") });
    let body = await res.json();
    assert.equal(body.choices[0].message.content, "hello ");
    assert.equal(body.choices[0].finish_reason, "stop");
    res = await chat(gateway, { max_tokens: 1, messages: user("IGNORE_CANCEL SAY<<hello STOP world>>") });
    body = await res.json();
    assert.equal(body.choices[0].message.content, "hell");
    assert.equal(body.choices[0].finish_reason, "length");
  } finally {
    await gateway.stop();
  }
});

test("#4: OutputLimiter flush stays within the length cap", () => {
  const limiter = new OutputLimiter(["ZZZZZZZZ"], 1);
  const visible = limiter.push("abcdefgh") + limiter.flush();
  assert.equal(visible, "abcd");
  assert.equal(limiter.cut?.reason, "length");
});

// --- lows ---------------------------------------------------------------------------------------

test("#5: a malformed percent-encoding in GET /v1/responses/{id} is a 400", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const res = await fetch(`${gateway.baseUrl}/v1/responses/%E0%A4%A`, { headers: HEADERS });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_request");
  } finally {
    await gateway.stop();
  }
});

test("#6/#7: stop sequences are bounded; max_tokens is validated next to max_completion_tokens", () => {
  const enforce = { enforceOutputLimits: true };
  const chatBase = { model: "m", messages: user("hi") };
  assert.throws(() => parseChatCompletionsRequest({ ...chatBase, stop: "x".repeat(257) }, enforce), /at most 256/);
  assert.deepEqual(parseChatCompletionsRequest({ ...chatBase, stop: "x".repeat(256) }, enforce).stop, ["x".repeat(256)]);
  assert.throws(() => parseChatCompletionsRequest({ ...chatBase, max_completion_tokens: 5, max_tokens: "abc" }, enforce), /max_tokens/);
  assert.equal(parseChatCompletionsRequest({ ...chatBase, max_completion_tokens: 5, max_tokens: 9 }, enforce).max_output_tokens, 5);
});

test("#8: response store limits are per key; one key cannot evict another's responses", () => {
  clearStoredResponses();
  try {
    storeResponse("victim", { id: "keep" }, 1000);
    for (let index = 0; index < 5000; index += 1) storeResponse("noisy", { id: `n${String(index)}` }, 1000);
    assert.equal(getStoredResponse("victim", "keep", 1001)?.id, "keep");
    assert.equal(getStoredResponse("noisy", "n4999", 1001)?.id, "n4999");
    assert.equal(getStoredResponse("noisy", `n${String(4999 - MAX_STORED_RESPONSES_PER_KEY)}`, 1001), undefined, "per-key cap");

    // Total full: the key holding the most entries loses its oldest, not the newcomer.
    clearStoredResponses();
    for (let key = 0; key < 10; key += 1) {
      for (let index = 0; index < MAX_STORED_RESPONSES_PER_KEY; index += 1) storeResponse(`k${String(key)}`, { id: `r${String(index)}` }, 1000);
    }
    storeResponse("small", { id: "s0" }, 1000);
    assert.equal(getStoredResponse("small", "s0", 1001)?.id, "s0");
    assert.equal(getStoredResponse("k0", "r0", 1001), undefined, "largest key's oldest dropped");
    assert.equal(getStoredResponse("k1", "r0", 1001)?.id, "r0");
  } finally {
    clearStoredResponses();
  }
});
