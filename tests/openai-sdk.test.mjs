import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI, { AuthenticationError, NotFoundError } from "openai";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const MODEL = "fake-model";
const CHAT_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a location.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};
const RESPONSES_TOOL = {
  type: "function",
  name: "get_weather",
  description: "Get the weather for a location.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

function clientFor(gateway, apiKey = CLIENT_KEY) {
  return new OpenAI({
    apiKey,
    baseURL: `${gateway.baseUrl}/v1`,
    maxRetries: 0,
  });
}

test("OpenAI SDK Chat Completions supports non-stream and stream usage", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const client = clientFor(gateway);
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.choices[0].message.content, "PONG");
    assert.deepEqual(
      [completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.total_tokens],
      [14, 2, 16],
    );

    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    assert.equal(text, "PONG");
    assert.deepEqual(
      [usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens],
      [14, 2, 16],
    );
  } finally {
    await gateway.stop();
  }
});

test("OpenAI SDK Chat Completions supports a function tool round trip", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const client = clientFor(gateway);
    const first = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "CALL_TOOL go" }],
      tools: [CHAT_TOOL],
    });
    const firstChoice = first.choices[0];
    const call = firstChoice.message.tool_calls?.[0];
    assert.equal(firstChoice.finish_reason, "tool_calls");
    assert.ok(call);
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "get_weather");

    const second = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "user", content: "CALL_TOOL go" },
        { role: "assistant", content: firstChoice.message.content, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "rainy" },
      ],
      tools: [CHAT_TOOL],
    });
    assert.equal(second.choices[0].message.content, "tool said: rainy");
    assert.equal(second.choices[0].finish_reason, "stop");
  } finally {
    await gateway.stop();
  }
});

test("OpenAI SDK Responses supports non-stream, stream, and retrieve", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const client = clientFor(gateway);
    const response = await client.responses.create({ model: MODEL, input: "ping" });
    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(response.output_text, "PONG");
    assert.deepEqual(
      [response.usage.input_tokens, response.usage.output_tokens, response.usage.total_tokens],
      [14, 2, 16],
    );

    const retrieved = await client.responses.retrieve(response.id);
    assert.equal(retrieved.id, response.id);
    assert.equal(retrieved.output_text, "PONG");

    const stream = await client.responses.create({ model: MODEL, input: "ping", stream: true });
    let text = "";
    let completed;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") text += event.delta;
      if (event.type === "response.completed") completed = event.response;
    }
    assert.equal(text, "PONG");
    assert.ok(completed?.id);
    const streamed = await client.responses.retrieve(completed.id);
    assert.equal(streamed.output_text, "PONG");
  } finally {
    await gateway.stop();
  }
});

test("OpenAI SDK Responses supports function_call continuation", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const client = clientFor(gateway);
    const first = await client.responses.create({
      model: MODEL,
      input: "CALL_TOOL go",
      tools: [RESPONSES_TOOL],
    });
    const call = first.output.find((item) => item.type === "function_call");
    assert.ok(call);
    assert.equal(call.name, "get_weather");
    assert.equal(first.status, "completed");

    const continued = await client.responses.create({
      model: MODEL,
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: "rainy" }],
    });
    assert.equal(continued.status, "completed");
    assert.equal(continued.output_text, "tool said: rainy");
  } finally {
    await gateway.stop();
  }
});

test("OpenAI SDK parses gateway 401 and 404 errors", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const unauthorized = clientFor(gateway, "cgk_wrong");
    await assert.rejects(
      () => unauthorized.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "ping" }] }),
      (error) => {
        assert.ok(error instanceof AuthenticationError);
        assert.equal(error.status, 401);
        assert.equal(error.code, "authentication_error");
        assert.equal(error.error.code, "authentication_error");
        return true;
      },
    );

    const client = clientFor(gateway);
    await assert.rejects(
      () => client.responses.retrieve("resp_missing"),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "not_found");
        assert.equal(error.error.code, "not_found");
        return true;
      },
    );
  } finally {
    await gateway.stop();
  }
});
