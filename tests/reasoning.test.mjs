import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEffortHint, resolveChatParams } from "../dist/cursor.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { parseResponsesRequest } from "../dist/responses.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const reasoner = {
  id: "fake-reasoner",
  displayName: "Fake Reasoner",
  parameters: [
    { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
  ],
  variants: [{ displayName: "Fake Reasoner", isDefault: true, params: [{ id: "reasoning_effort", value: "medium" }] }],
};
const plain = { id: "plain", displayName: "Plain", parameters: [], variants: [] };

function hinted(model, hint) {
  const merged = new Map();
  applyEffortHint(model, merged, hint);
  return merged.get("reasoning_effort");
}

test("effort hints pick exact or nearest levels and never escalate on ties", () => {
  assert.equal(hinted(reasoner, "high"), "high");
  assert.equal(hinted(reasoner, "HIGH"), "high");
  assert.equal(hinted(reasoner, "xhigh"), "high");
  assert.equal(hinted(reasoner, "max"), "high");
  assert.equal(hinted(reasoner, "minimal"), "low");
  assert.equal(hinted(reasoner, "none"), "low");
  assert.equal(hinted(reasoner, "turbo"), undefined);
  assert.equal(hinted(plain, "high"), undefined);
  const gap = { ...reasoner, parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }] };
  const merged = new Map();
  applyEffortHint(gap, merged, "medium");
  assert.equal(merged.get("effort"), "low");
  const boolean = { ...reasoner, parameters: [{ id: "reasoning", values: [{ value: "true" }, { value: "false" }] }] };
  const none = new Map();
  applyEffortHint(boolean, none, "high");
  assert.equal(none.size, 0);
});

test("Responses reasoning.effort is a hint; Chat reasoning_effort is soft unless the value is unknown", () => {
  const responses = parseResponsesRequest({ model: "plain", input: "hi", reasoning: { effort: "high", summary: "auto" } });
  assert.equal(responses.reasoning_effort, undefined);
  assert.equal(responses.reasoning_effort_hint, "high");
  assert.equal(resolveChatParams(plain, responses), undefined);
  assert.deepEqual(resolveChatParams(reasoner, responses), [{ id: "reasoning_effort", value: "high" }]);

  const xhigh = parseResponsesRequest({ model: "fake-reasoner", input: "hi", reasoning: { effort: "xhigh" } });
  assert.deepEqual(resolveChatParams(reasoner, xhigh), [{ id: "reasoning_effort", value: "high" }]);

  const explicit = parseResponsesRequest({ model: "fake-reasoner", input: "hi", reasoning_effort: "low", reasoning: { effort: "high" } });
  assert.deepEqual(resolveChatParams(reasoner, explicit), [{ id: "reasoning_effort", value: "low" }]);

  const chat = parseChatCompletionsRequest({ model: "plain", reasoning_effort: "high", messages: [{ role: "user", content: "x" }] });
  assert.equal(resolveChatParams(plain, chat), undefined, "model without an effort control: ignored, no 400");
  const nearest = parseChatCompletionsRequest({ model: "fake-reasoner", reasoning_effort: "xhigh", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(resolveChatParams(reasoner, nearest), [{ id: "reasoning_effort", value: "high" }], "nearest level");
  const minimal = parseChatCompletionsRequest({ model: "fake-reasoner", reasoning_effort: "minimal", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(resolveChatParams(reasoner, minimal), [{ id: "reasoning_effort", value: "low" }]);
  const bogus = parseChatCompletionsRequest({ model: "fake-reasoner", reasoning_effort: "banana", messages: [{ role: "user", content: "x" }] });
  assert.throws(() => resolveChatParams(reasoner, bogus), /Invalid reasoning_effort='banana'/);
  assert.throws(() => resolveChatParams(plain, { ...bogus, model: "plain" }), /Invalid reasoning_effort/);
  const thinking = {
    id: "toggle",
    parameters: [{ id: "thinking", displayName: "Thinking", values: [{ value: "true" }, { value: "false" }] }],
    variants: [{ displayName: "T", isDefault: true, params: [{ id: "thinking", value: "true" }] }],
  };
  const off = parseChatCompletionsRequest({ model: "toggle", reasoning_effort: "none", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(resolveChatParams(thinking, off), [{ id: "thinking", value: "false" }], "boolean thinking toggle");
  const noHint = parseResponsesRequest({ model: "fake-reasoner", input: "hi" });
  assert.deepEqual(resolveChatParams(reasoner, noHint), [{ id: "reasoning_effort", value: "medium" }]);
});

test("Codex-style Responses requests with reasoning.effort reach the model over HTTP", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  const post = (body) =>
    fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const plainModel = await post({ model: "fake-model", input: "ping", reasoning: { effort: "medium", summary: "auto" } });
    assert.equal(plainModel.status, 200, await plainModel.clone().text());

    const echoed = await post({ model: "fake-reasoner", input: "ECHO_MODEL", reasoning: { effort: "xhigh" } });
    assert.equal(echoed.status, 200);
    const body = await echoed.json();
    const text = body.output.find((item) => item.type === "message").content[0].text;
    assert.deepEqual(JSON.parse(text), { id: "fake-reasoner", params: [{ id: "reasoning_effort", value: "high" }] });
  } finally {
    await gateway.stop();
  }
});
