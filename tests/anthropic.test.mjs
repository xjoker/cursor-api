import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnthropicStreamWriter,
  encodeAnthropicMessage,
  parseAnthropicMessagesRequest,
  toAnthropicErrorBody,
} from "../dist/anthropic.js";
import { GatewayError, invalidRequest, rateLimitError } from "../dist/errors.js";
import { sendAnthropicError } from "../dist/http.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

test("anthropic parse maps system, text, images, tools and tool_choice", () => {
  const parsed = parseAnthropicMessagesRequest({
    model: "composer-2.5",
    max_tokens: 1024,
    temperature: 1,
    thinking: { type: "enabled", budget_tokens: 2048 },
    system: [
      { type: "text", text: "You are terse." },
      { type: "text", text: "Answer in English.", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
    ],
    tools: [
      { name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
      { type: "web_search_20250305", name: "web_search" },
    ],
    tool_choice: { type: "tool", name: "get_weather" },
    metadata: { user_id: "u-1", conversation_id: "conv-a" },
  });
  assert.equal(parsed.model, "composer-2.5");
  assert.equal(parsed.stream, false);
  assert.equal(parsed.includeUsage, true);
  assert.equal(parsed.messages[0].role, "system");
  assert.equal(parsed.messages[0].content, "You are terse.\n\nAnswer in English.");
  assert.equal(parsed.messages[1].role, "user");
  assert.match(parsed.messages[1].content, /What is this\?/);
  assert.deepEqual(parsed.images, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
  assert.deepEqual(parsed.tools?.map((tool) => tool.name), ["get_weather"]);
  assert.deepEqual(parsed.tool_choice, { name: "get_weather" });
  assert.equal(parsed.conversation_id, "conv-a");
});

test("anthropic parse turns tool_use / tool_result into a tool round", () => {
  const parsed = parseAnthropicMessagesRequest({
    model: "composer-2.5",
    max_tokens: 64,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SG" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "31C" }] },
          { type: "text", text: "<reminder>be brief</reminder>" },
        ],
      },
    ],
    tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    tool_choice: { type: "any" },
  });
  assert.equal(parsed.messages.length, 3);
  assert.deepEqual(parsed.messages[1].tool_calls, [
    { id: "call_1", name: "get_weather", arguments: '{"city":"SG"}' },
  ]);
  assert.equal(parsed.messages[1].content, "Checking.");
  assert.equal(parsed.messages[2].role, "tool");
  assert.equal(parsed.messages[2].tool_call_id, "call_1");
  assert.equal(parsed.messages[2].content, "31C\n\n<reminder>be brief</reminder>");
  assert.equal(parsed.tool_choice, "auto");
});

test("anthropic parse marks error tool results and rejects unsupported input", () => {
  const parsed = parseAnthropicMessagesRequest({
    model: "m",
    max_tokens: 1,
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", is_error: true, content: "boom" }] },
    ],
  });
  assert.equal(parsed.messages[2].content, "[error]\nboom");

  const bad = [
    [{ model: "m", messages: [{ role: "tool", content: "x" }] }, /role must be/],
    [{ model: "m", messages: [{ role: "user", content: "x" }], stop_sequences: ["\n"] }, /stop_sequences/],
    [{ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 0 }, /max_tokens/],
    [{ model: "m", messages: [{ role: "user", content: [{ type: "document" }] }] }, /not supported/],
    [{ model: "m", messages: [] }, /non-empty array/],
    [{ model: "m", messages: [{ role: "user", content: "x" }], tool_choice: { type: "required" } }, /tool_choice.type/],
  ];
  for (const [body, pattern] of bad) {
    assert.throws(
      () => parseAnthropicMessagesRequest(body),
      (error) => error instanceof GatewayError && error.httpStatus === 400 && pattern.test(error.message),
    );
  }
});

test("anthropic non-stream encoding maps blocks, stop_reason and usage", () => {
  const body = encodeAnthropicMessage({
    id: "msg_1",
    model: "composer-2.5",
    content: "Calling.",
    reasoning_content: "think",
    tool_calls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"SG"}' }],
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cache_read_tokens: 6 },
  });
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "tool_use");
  assert.deepEqual(body.content, [
    { type: "thinking", thinking: "think", signature: "" },
    { type: "text", text: "Calling." },
    { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SG" } },
  ]);
  // Gateway usage follows OpenAI (prompt includes cached); Anthropic input_tokens excludes it.
  assert.deepEqual(body.usage, {
    input_tokens: 4,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 6,
  });
  const plain = encodeAnthropicMessage({ id: "msg_2", model: "m", content: "hi", usage: null });
  assert.equal(plain.stop_reason, "end_turn");
  assert.equal(plain.usage.input_tokens, 0);
});

test("anthropic error bodies use Anthropic error types", () => {
  assert.deepEqual(toAnthropicErrorBody(invalidRequest("nope"), "msg_x"), {
    type: "error",
    error: { type: "invalid_request_error", message: "nope", code: "invalid_request" },
    request_id: "msg_x",
  });
  assert.equal(toAnthropicErrorBody(rateLimitError("slow")).error.type, "rate_limit_error");
  assert.equal(toAnthropicErrorBody(new GatewayError(502, "upstream_error", "x", "upstream_error")).error.type, "api_error");
  assert.equal(toAnthropicErrorBody(new Error("hidden")).error.message, "Internal server error");
});

test("anthropic stream writer emits a well-formed event sequence", async () => {
  const events = [];
  const writer = new AnthropicStreamWriter(async (event, data) => {
    events.push({ event, data });
  }, { id: "msg_s", model: "m" });
  await writer.start();
  await writer.onThinking("a");
  await writer.onThinking("b");
  await writer.onText("Hel");
  await writer.onText("lo");
  await writer.onToolCalls([{ id: "call_1", name: "t", arguments: '{"x":1}' }]);
  await writer.complete({
    content: "Hello",
    tool_calls: [{ id: "call_1", name: "t", arguments: '{"x":1}' }],
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.deepEqual(
    events.map((item) => item.event),
    [
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(events.filter((e) => e.event === "content_block_start").map((e) => e.data.index), [0, 1, 2]);
  assert.equal(events[10].data.content_block.type, "tool_use");
  assert.equal(events[11].data.delta.partial_json, '{"x":1}');
  assert.equal(events[13].data.delta.stop_reason, "tool_use");
  assert.equal(events[13].data.usage.output_tokens, 2);
});

test("anthropic stream writer backfills text that never streamed and reports failures", async () => {
  const events = [];
  const writer = new AnthropicStreamWriter(async (event, data) => {
    events.push({ event, data });
  }, { id: "msg_f", model: "m" });
  await writer.start();
  await writer.complete({ content: "late", finish_reason: "stop", usage: null });
  assert.equal(events.find((e) => e.event === "content_block_delta").data.delta.text, "late");

  const failed = [];
  const failing = new AnthropicStreamWriter(async (event, data) => {
    failed.push({ event, data });
  }, { id: "msg_g", model: "m" });
  await failing.start();
  await failing.onText("partial");
  await failing.fail(rateLimitError("limit"));
  assert.deepEqual(failed.slice(-2).map((e) => e.event), ["content_block_stop", "error"]);
  assert.equal(failed.at(-1).data.error.type, "rate_limit_error");
});

test("POST /v1/messages works end to end against a fake Cursor SDK", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  const headers = {
    "x-api-key": CLIENT_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  try {
    const unauth = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(unauth.status, 401);
    const unauthBody = await unauth.json();
    assert.equal(unauthBody.type, "error");
    assert.equal(unauthBody.error.type, "authentication_error");

    const invalid = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fake-model", max_tokens: 8, messages: [{ role: "tool", content: "x" }] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.type, "invalid_request_error");

    const unknownModel = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "nope", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(unknownModel.status, 404);
    assert.equal((await unknownModel.json()).error.type, "not_found_error");

    const preflight = await fetch(`${gateway.baseUrl}/v1/messages`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Anthropic-Version/);

    const plain = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fake-alias", max_tokens: 8, system: "be nice", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(plain.status, 200);
    const message = await plain.json();
    assert.equal(message.type, "message");
    assert.equal(message.stop_reason, "end_turn");
    assert.deepEqual(message.content, [
      { type: "thinking", thinking: "pondering", signature: "" },
      { type: "text", text: "PONG" },
    ]);
    assert.equal(message.usage.input_tokens, 11);
    assert.equal(message.usage.cache_read_input_tokens, 3);

    const streamed = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fake-model", max_tokens: 8, stream: true, messages: [{ role: "user", content: "stream ping" }] }),
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames = parseSse(await streamed.text());
    assert.equal(frames[0].event, "message_start");
    assert.equal(frames.at(-1).event, "message_stop");
    const text = frames
      .filter((f) => f.event === "content_block_delta" && f.data.delta.type === "text_delta")
      .map((f) => f.data.delta.text)
      .join("");
    assert.equal(text, "PONG");
    assert.equal(frames.find((f) => f.event === "message_delta").data.delta.stop_reason, "end_turn");
    for (const frame of frames) assert.equal(frame.data.type, frame.event);

    const tools = [{ name: "get_weather", input_schema: { type: "object", properties: { query: { type: "string" } } } }];
    const first = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fake-model", max_tokens: 64, tools, messages: [{ role: "user", content: "CALL_TOOL please" }] }),
    });
    assert.equal(first.status, 200);
    const toolTurn = await first.json();
    assert.equal(toolTurn.stop_reason, "tool_use");
    const toolUse = toolTurn.content.find((block) => block.type === "tool_use");
    assert.equal(toolUse.name, "get_weather");
    assert.deepEqual(toolUse.input, { query: "weather" });

    const second = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fake-model",
        max_tokens: 64,
        tools,
        messages: [
          { role: "user", content: "CALL_TOOL please" },
          { role: "assistant", content: toolTurn.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "sunny" }] },
        ],
      }),
    });
    assert.equal(second.status, 200);
    const final = await second.json();
    assert.equal(final.stop_reason, "end_turn");
    assert.equal(final.content.find((block) => block.type === "text").text, "tool said: sunny");

    const failing = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fake-model", max_tokens: 8, messages: [{ role: "user", content: "FAIL_RATE_LIMIT" }] }),
    });
    assert.equal(failing.status, 429);
    assert.equal((await failing.json()).error.type, "rate_limit_error");
  } finally {
    await gateway.stop();
  }
});


test("Anthropic authentication throttling retains Retry-After", () => {
  const error = rateLimitError("Too many failed authentications");
  error.retryAfterSeconds = 42;
  let status;
  let headers;
  let payload;
  sendAnthropicError({
    writeHead(value, fields) { status = value; headers = fields; },
    end(value) { payload = JSON.parse(value); },
  }, error, "test-request");
  assert.equal(status, 429);
  assert.equal(headers["retry-after"], "42");
  assert.equal(payload.error.type, "rate_limit_error");
});
