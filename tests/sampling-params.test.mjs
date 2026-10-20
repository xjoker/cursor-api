import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const base = {
  model: "fake-model",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } }],
};
const sampling = {
  temperature: 0.2,
  top_p: 0.9,
  top_k: 40,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: 7,
  parallel_tool_calls: false,
};

test("ignore_sampling_params is off by default and configurable via TOML or env", (context) => {
  const root = makeTempDir(context, "cursor-api-sampling-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  const file = join(root, "data", "config", "gateway.toml");
  const secrets = ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"'];
  writeFileSync(file, [...secrets, ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).ignoreSamplingParams, false);
  assert.equal(loadConfig({ DATA_DIR: "data", IGNORE_SAMPLING_PARAMS: "true" }, root).ignoreSamplingParams, true);
  writeFileSync(file, [...secrets, "ignore_sampling_params = true", ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).ignoreSamplingParams, true);
  assert.equal(loadConfig({ DATA_DIR: "data", IGNORE_SAMPLING_PARAMS: "false" }, root).ignoreSamplingParams, false);
});

test("sampling knobs are rejected by default and dropped when ignored", () => {
  for (const [field, value] of Object.entries(sampling)) {
    const body = { ...base, [field]: value };
    assert.throws(
      () => parseChatCompletionsRequest(body),
      (error) => error instanceof Error && error.message.includes(field),
      field,
    );
    const parsed = parseChatCompletionsRequest(body, { ignoreSamplingParams: true });
    assert.equal(parsed.model, "fake-model");
    assert.equal(parsed.tools?.length, 1);
  }
  const all = parseChatCompletionsRequest({ ...base, ...sampling }, { ignoreSamplingParams: true });
  assert.equal(all.messages.length, 1);
});

test("output-shaping and legacy fields stay rejected even when sampling knobs are ignored", () => {
  for (const [field, value] of [
    ["stop", ["\n"]],
    ["logit_bias", { 1: 2 }],
    ["functions", [{ name: "x" }]],
    ["n", 2],
  ]) {
    assert.throws(
      () => parseChatCompletionsRequest({ ...base, [field]: value }, { ignoreSamplingParams: true }),
      (error) => error instanceof Error && error.message.includes(field),
      field,
    );
  }
  assert.throws(
    () => parseChatCompletionsRequest({ ...base, parallel_tool_calls: "no" }, { ignoreSamplingParams: true }),
    /parallel_tool_calls/,
  );
});

test("chat completions honors ignore_sampling_params over HTTP", { timeout: 20_000 }, async () => {
  const body = JSON.stringify({ model: "fake-model", temperature: 0.7, seed: 1, messages: [{ role: "user", content: "ping" }] });
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };

  const strict = await startFakeGateway();
  try {
    const res = await fetch(`${strict.baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /temperature/);
  } finally {
    await strict.stop();
  }

  const lenient = await startFakeGateway({ IGNORE_SAMPLING_PARAMS: "true" });
  try {
    const res = await fetch(`${lenient.baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "PONG");
  } finally {
    await lenient.stop();
  }
});
