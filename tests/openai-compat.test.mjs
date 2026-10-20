// PR B (SAF-95 OpenAI compat): OpenRouter `reasoning`, dual reasoning output, gateway-enforced
// max_tokens / stop, JSON modes, GET /v1/responses/{id}. All offline (fake SDK).
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicStopReason, parseAnthropicMessagesRequest } from "../dist/anthropic.js";
import { encodeNonStreamCompletion, encodeStreamChunk, effortForBudget, parseChatCompletionsRequest, parseReasoningObject } from "../dist/openai.js";
import { CHARS_PER_TOKEN, clientFinishReason, normalizeJsonReply, OutputLimiter, outputFormatInstruction } from "../dist/output-limits.js";
import { clearStoredResponses, getStoredResponse, MAX_STORED_RESPONSES, RESPONSE_TTL_MS, storeResponse } from "../dist/response-store.js";
import { parseResponsesRequest, responseStatusOf } from "../dist/responses.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const base = { model: "fake-model", messages: [{ role: "user", content: "hi" }] };
const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const post = (gateway, path, body) => fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

// --- OpenRouter `reasoning` object -------------------------------------------------------------

test("reasoning object: effort / max_tokens / enabled / exclude become soft hints", () => {
  assert.deepEqual(parseReasoningObject({ effort: "high" }), { effort: "high" });
  assert.deepEqual(parseReasoningObject({ max_tokens: 1000 }), { effort: "low" });
  assert.deepEqual(parseReasoningObject({ max_tokens: 8000 }), { effort: "medium" });
  assert.deepEqual(parseReasoningObject({ max_tokens: 20000 }), { effort: "high" });
  assert.deepEqual(parseReasoningObject({ enabled: false, effort: "high" }), { effort: "none" });
  assert.deepEqual(parseReasoningObject({ enabled: true }), { effort: "medium" });
  assert.deepEqual(parseReasoningObject({ exclude: true }), { exclude: true });
  assert.deepEqual(parseReasoningObject(undefined), {});
  assert.equal(effortForBudget(0), "none");
  for (const bad of [{ effort: 3 }, { max_tokens: -1 }, { exclude: "yes" }, { nope: 1 }, "high"]) {
    assert.throws(() => parseReasoningObject(bad), /reasoning/, JSON.stringify(bad));
  }
});

test("chat parse maps `reasoning` to a hint and keeps explicit reasoning_effort separate", () => {
  const parsed = parseChatCompletionsRequest({ ...base, reasoning: { effort: "xhigh", exclude: true } });
  assert.equal(parsed.reasoning_effort_hint, "xhigh");
  assert.equal(parsed.reasoning_exclude, true);
  assert.equal(parsed.reasoning_effort, undefined);
  const both = parseChatCompletionsRequest({ ...base, reasoning_effort: "low", reasoning: { effort: "high" } });
  assert.equal(both.reasoning_effort, "low"); // explicit wins in resolveChatParams; the hint is ignored
});

test("reasoning text is returned as both reasoning_content and reasoning", () => {
  const body = encodeNonStreamCompletion({ id: "c", created: 1, model: "m", content: "x", usage: null, reasoning_content: "think" });
  assert.equal(body.choices[0].message.reasoning_content, "think");
  assert.equal(body.choices[0].message.reasoning, "think");
  const chunk = encodeStreamChunk({ id: "c", created: 1, model: "m", reasoning_content: "th" });
  assert.equal(chunk.choices[0].delta.reasoning_content, "th");
  assert.equal(chunk.choices[0].delta.reasoning, "th");
});

// --- max_tokens / stop --------------------------------------------------------------------------

test("without enforce_output_limits: max_tokens accepted and ignored, stop still 400 (current behaviour)", () => {
  const parsed = parseChatCompletionsRequest({ ...base, max_tokens: 0, max_completion_tokens: 5 });
  assert.equal(parsed.max_output_tokens, undefined);
  assert.throws(() => parseChatCompletionsRequest({ ...base, stop: "x" }), /stop.*enforce_output_limits/);
  assert.throws(() => parseChatCompletionsRequest({ ...base, stop: "x" }, { ignoreSamplingParams: true }), /stop/);
  assert.equal(parseResponsesRequest({ model: "m", input: "hi", max_output_tokens: 3 }).max_output_tokens, undefined);
  assert.throws(() => parseAnthropicMessagesRequest({ model: "m", max_tokens: 9, stop_sequences: ["x"], messages: [{ role: "user", content: "hi" }] }), /stop_sequences/);
});

test("with enforce_output_limits: stop / max_tokens are parsed and validated", () => {
  const on = { enforceOutputLimits: true };
  assert.deepEqual(parseChatCompletionsRequest({ ...base, stop: "END" }, on).stop, ["END"]);
  assert.deepEqual(parseChatCompletionsRequest({ ...base, stop: ["a", "b"] }, on).stop, ["a", "b"]);
  assert.equal(parseChatCompletionsRequest({ ...base, stop: [] }, on).stop, undefined);
  assert.equal(parseChatCompletionsRequest({ ...base, stop: null }, on).stop, undefined);
  assert.throws(() => parseChatCompletionsRequest({ ...base, stop: ["a", "b", "c", "d", "e"] }, on), /stop/);
  assert.throws(() => parseChatCompletionsRequest({ ...base, stop: [""] }, on), /stop/);
  assert.equal(parseChatCompletionsRequest({ ...base, max_tokens: 7 }, on).max_output_tokens, 7);
  assert.equal(parseChatCompletionsRequest({ ...base, max_tokens: 7, max_completion_tokens: 3 }, on).max_output_tokens, 3);
  assert.throws(() => parseChatCompletionsRequest({ ...base, max_tokens: 0 }, on), /max_tokens/);
  assert.equal(parseResponsesRequest({ model: "m", input: "hi", max_output_tokens: 3 }, on).max_output_tokens, 3);
  const anthropic = parseAnthropicMessagesRequest({ model: "m", max_tokens: 9, stop_sequences: ["x"], messages: [{ role: "user", content: "hi" }] }, on);
  assert.equal(anthropic.max_output_tokens, 9);
  assert.deepEqual(anthropic.stop, ["x"]);
});

test("OutputLimiter: stop sequence split across deltas never leaks; earliest stop wins", () => {
  const limiter = new OutputLimiter(["STOP", "<<"]);
  let shown = "";
  for (const part of ["hel", "lo S", "TO", "P tail"]) shown += limiter.push(part);
  assert.equal(shown, "hello ");
  assert.deepEqual(limiter.cut, { reason: "stop", sequence: "STOP" });
  assert.equal(limiter.push("more"), "");
  assert.equal(limiter.flush(), "");

  const tail = new OutputLimiter(["STOP"]);
  assert.equal(tail.push("abcST") + tail.flush(), "abcST"); // held-back prefix released at the end
  assert.equal(tail.cut, undefined);
});

test("OutputLimiter: length cap uses the char estimate and keeps surrogate pairs whole", () => {
  const limiter = new OutputLimiter([], 2);
  assert.equal(limiter.push("abcdef"), "abcdef");
  assert.equal(limiter.push("ghij"), "gh");
  assert.deepEqual(limiter.cut, { reason: "length" });
  assert.equal(CHARS_PER_TOKEN * 2, 8);
  const emoji = new OutputLimiter([], 1);
  assert.equal(emoji.push("abc😀"), "abc"); // 😀 would straddle the 4-char limit
  const both = new OutputLimiter(["Z"], 1);
  assert.equal(both.push("abcdefZ"), "abcd");
  assert.equal(both.cut.reason, "length");
});

test("finish reasons map per API", () => {
  assert.equal(clientFinishReason({ finish_reason: "length" }), "length");
  assert.equal(clientFinishReason({ finish_reason: "tool_calls" }), "tool_calls");
  assert.equal(clientFinishReason({ finish_reason: "stop" }), "stop");
  assert.equal(responseStatusOf("length"), "incomplete");
  assert.equal(responseStatusOf("stop"), "completed");
  assert.equal(anthropicStopReason("length"), "max_tokens");
  assert.equal(anthropicStopReason("stop", "X"), "stop_sequence");
  assert.equal(anthropicStopReason("stop"), "end_turn");
});

// --- JSON modes ---------------------------------------------------------------------------------

test("response_format / text.format: json_object and json_schema are parsed, others rejected", () => {
  assert.deepEqual(parseChatCompletionsRequest({ ...base, response_format: { type: "json_object" } }).output_format, { type: "json_object" });
  const schema = { type: "object", properties: { a: { type: "number" } } };
  assert.deepEqual(
    parseChatCompletionsRequest({ ...base, response_format: { type: "json_schema", json_schema: { name: "r", schema, strict: true } } }).output_format,
    { type: "json_schema", name: "r", schema, strict: true },
  );
  assert.equal(parseChatCompletionsRequest({ ...base, response_format: { type: "text" } }).output_format, undefined);
  assert.throws(() => parseChatCompletionsRequest({ ...base, response_format: { type: "xml" } }), /response_format/);
  assert.throws(() => parseChatCompletionsRequest({ ...base, response_format: { type: "json_schema", json_schema: { schema: 1 } } }), /schema/);
  assert.deepEqual(
    parseResponsesRequest({ model: "m", input: "hi", text: { format: { type: "json_schema", name: "r", schema } } }).output_format,
    { type: "json_schema", name: "r", schema },
  );
  assert.equal(parseResponsesRequest({ model: "m", input: "hi", text: { format: { type: "text" } } }).output_format, undefined);
});

test("JSON instruction and reply normalisation", () => {
  assert.equal(outputFormatInstruction(undefined), "");
  assert.match(outputFormatInstruction({ type: "json_object" }), /JSON object/);
  assert.match(outputFormatInstruction({ type: "json_schema", name: "r", schema: { type: "object" } }), /JSON Schema named "r": \{"type":"object"\}/);
  assert.deepEqual(normalizeJsonReply('```json\n{"a":1}\n```', true), { text: '{"a":1}', valid: true });
  assert.deepEqual(normalizeJsonReply('```json\n{"a":1}\n```', false), { text: '```json\n{"a":1}\n```', valid: false });
  assert.deepEqual(normalizeJsonReply("not json", true), { text: "not json", valid: false });
});

// --- response store -----------------------------------------------------------------------------

test("response store: scoped per client key, expires, bounded", () => {
  clearStoredResponses();
  storeResponse("k1", { id: "resp_1", object: "response" }, 1000);
  assert.equal(getStoredResponse("k1", "resp_1", 1001).id, "resp_1");
  assert.equal(getStoredResponse("k2", "resp_1", 1001), undefined);
  assert.equal(getStoredResponse("k1", "resp_1", 1000 + RESPONSE_TTL_MS), undefined);
  for (let index = 0; index <= MAX_STORED_RESPONSES; index += 1) storeResponse("k1", { id: `r${String(index)}` }, 5000);
  assert.equal(getStoredResponse("k1", "r0", 5001), undefined);
  assert.equal(getStoredResponse("k1", `r${String(MAX_STORED_RESPONSES)}`, 5001)?.id, `r${String(MAX_STORED_RESPONSES)}`);
  clearStoredResponses();
});

// --- end to end ---------------------------------------------------------------------------------

test("e2e: dual reasoning fields, reasoning.exclude, default limits behaviour", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    let res = await post(gateway, "/v1/chat/completions", { ...base, messages: [{ role: "user", content: "ping" }], reasoning: { effort: "high" } });
    assert.equal(res.status, 200);
    let message = (await res.json()).choices[0].message;
    assert.equal(message.reasoning_content, "pondering");
    assert.equal(message.reasoning, "pondering");

    res = await post(gateway, "/v1/chat/completions", { ...base, stream: true, messages: [{ role: "user", content: "ping" }] });
    const deltas = parseSse(await res.text()).filter((frame) => frame.data !== "[DONE]").map((frame) => frame.data.choices?.[0]?.delta ?? {});
    const thinking = deltas.find((delta) => delta.reasoning_content);
    assert.equal(thinking.reasoning, thinking.reasoning_content);

    res = await post(gateway, "/v1/chat/completions", { ...base, messages: [{ role: "user", content: "ping" }], reasoning: { exclude: true } });
    message = (await res.json()).choices[0].message;
    assert.equal(message.content, "PONG");
    assert.equal(message.reasoning_content, undefined);
    assert.equal(message.reasoning, undefined);

    // Switch off (default): max_tokens ignored, stop rejected.
    res = await post(gateway, "/v1/chat/completions", { ...base, max_tokens: 1, messages: [{ role: "user", content: "SAY<<hello world>>" }] });
    assert.equal((await res.json()).choices[0].message.content, "hello world");
    res = await post(gateway, "/v1/chat/completions", { ...base, stop: "o", messages: [{ role: "user", content: "SAY<<hello>>" }] });
    assert.equal(res.status, 400);
  } finally {
    await gateway.stop();
  }
});

test("e2e: enforce_output_limits cuts at stop / max_tokens on chat, responses and messages", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true" });
  const say = "SAY<<hello STOP world and more>>";
  try {
    let res = await post(gateway, "/v1/chat/completions", { ...base, stop: ["STOP"], messages: [{ role: "user", content: say }] });
    let body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, "hello ");
    assert.equal(body.choices[0].finish_reason, "stop");

    res = await post(gateway, "/v1/chat/completions", { ...base, stream: true, stop: "STOP", messages: [{ role: "user", content: say }] });
    const frames = parseSse(await res.text()).filter((frame) => frame.data !== "[DONE]").map((frame) => frame.data);
    const streamed = frames.map((frame) => frame.choices?.[0]?.delta?.content ?? "").join("");
    assert.equal(streamed, "hello ");
    assert.equal(frames.find((frame) => frame.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "stop");

    res = await post(gateway, "/v1/chat/completions", { ...base, max_tokens: 2, messages: [{ role: "user", content: say }] });
    body = await res.json();
    assert.equal(body.choices[0].message.content, "hello ST");
    assert.equal(body.choices[0].finish_reason, "length");

    // Text shorter than the limit: untouched.
    res = await post(gateway, "/v1/chat/completions", { ...base, max_tokens: 100, stop: "zzz", messages: [{ role: "user", content: "SAY<<short>>" }] });
    body = await res.json();
    assert.equal(body.choices[0].message.content, "short");
    assert.equal(body.choices[0].finish_reason, "stop");

    res = await post(gateway, "/v1/responses", { model: "fake-model", input: say, max_output_tokens: 1 });
    body = await res.json();
    assert.equal(body.status, "incomplete");
    assert.deepEqual(body.incomplete_details, { reason: "max_output_tokens" });
    assert.equal(body.output.find((item) => item.type === "message").content[0].text, "hell");

    res = await post(gateway, "/v1/messages", { model: "fake-model", max_tokens: 100, stop_sequences: ["STOP"], messages: [{ role: "user", content: say }] });
    body = await res.json();
    assert.equal(body.stop_reason, "stop_sequence");
    assert.equal(body.stop_sequence, "STOP");
    assert.equal(body.content.find((block) => block.type === "text").text, "hello ");

    res = await post(gateway, "/v1/messages", { model: "fake-model", max_tokens: 1, stream: true, messages: [{ role: "user", content: say }] });
    const events = parseSse(await res.text());
    const delta = events.find((frame) => frame.event === "message_delta");
    assert.equal(delta.data.delta.stop_reason, "max_tokens");
  } finally {
    await gateway.stop();
  }
});

test("e2e: JSON mode adds the instruction upstream and strips a fence (non-stream)", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    let res = await post(gateway, "/v1/chat/completions", { ...base, response_format: { type: "json_object" }, messages: [{ role: "user", content: "ECHO_PROMPT_TAIL" }] });
    assert.match((await res.json()).choices[0].message.content, /\[Output format\].*JSON object/);

    res = await post(gateway, "/v1/chat/completions", {
      ...base,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: 'SAY<<```json\n{"a":1}\n```>>' }],
    });
    assert.equal((await res.json()).choices[0].message.content, '{"a":1}');

    res = await post(gateway, "/v1/responses", {
      model: "fake-model",
      input: "ECHO_PROMPT_TAIL",
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    });
    const text = (await res.json()).output.find((item) => item.type === "message").content[0].text;
    assert.match(text, /JSON Schema named "answer"/);
  } finally {
    await gateway.stop();
  }
});

test("e2e: GET /v1/responses/{id} returns the stored final response", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    let res = await post(gateway, "/v1/responses", { model: "fake-model", input: "ping" });
    const created = await res.json();
    res = await fetch(`${gateway.baseUrl}/v1/responses/${created.id}`, { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), created);

    res = await post(gateway, "/v1/responses", { model: "fake-model", input: "ping", stream: true });
    const completed = parseSse(await res.text()).find((frame) => frame.event === "response.completed");
    const streamed = completed.data.response;
    res = await fetch(`${gateway.baseUrl}/v1/responses/${streamed.id}`, { headers });
    assert.deepEqual(await res.json(), streamed);

    res = await post(gateway, "/v1/responses", { model: "fake-model", input: "ping", store: false });
    const unstored = await res.json();
    res = await fetch(`${gateway.baseUrl}/v1/responses/${unstored.id}`, { headers });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");

    res = await fetch(`${gateway.baseUrl}/v1/responses/${created.id}`, { headers: { authorization: "Bearer cgk_wrong" } });
    assert.equal(res.status, 401);
  } finally {
    await gateway.stop();
  }
});

test("e2e: limits also hold when deltas are buffered for the max-mode check (allow_max_mode=false)", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true", ALLOW_MAX_MODE: "false" });
  try {
    const res = await post(gateway, "/v1/chat/completions", { ...base, stream: true, stop: "STOP", messages: [{ role: "user", content: "SAY<<abc STOP def>>" }] });
    const frames = parseSse(await res.text()).filter((frame) => frame.data !== "[DONE]").map((frame) => frame.data);
    assert.equal(frames.map((frame) => frame.choices?.[0]?.delta?.content ?? "").join(""), "abc ");
  } finally {
    await gateway.stop();
  }
});
