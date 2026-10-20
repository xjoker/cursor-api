// Max-mode guard, review round 2: mixed params (N2), SDK-resolved max mode (N1/N3),
// pinned SDK rule (N4), softened hints (N5), deterministic fallback (N6).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  configureMaxMode,
  maxOnlyParamValues,
  resolveCatalogModelSelection,
  sdkWouldUseMaxMode,
  wasHintSoftened,
} from "../dist/cursor.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { parseResponsesRequest } from "../dist/responses.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const fakeMax = {
  id: "fake-max",
  parameters: [
    { id: "context", values: [{ value: "200k" }, { value: "1m" }] },
    { id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }, { value: "max" }] },
  ],
  variants: [
    { displayName: "Low", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "low" }] },
    { displayName: "High", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "high" }] },
    { displayName: "1M High", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }] },
    { displayName: "Max", isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "max" }] },
  ],
};
const chat = (body) => parseChatCompletionsRequest({ messages: [{ role: "user", content: "hi" }], ...body });
const paramsOf = (selection) => Object.fromEntries((selection.params ?? []).map((p) => [p.id, p.value]));
const is403 = (error) => error.httpStatus === 403 && error.code === "max_mode_not_allowed";

function withMaxMode(allow, fn) {
  configureMaxMode({ allowMaxMode: allow });
  try {
    return fn();
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
}

test("N2: max-only param values are never forwarded when max mode is disallowed", () => {
  assert.deepEqual(maxOnlyParamValues(fakeMax, [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "low" }]), [
    { id: "context", value: "1m" },
  ]);
  assert.deepEqual(maxOnlyParamValues(fakeMax, [{ id: "reasoning_effort", value: "high" }]), [], "high also exists at 200k");
  assert.deepEqual(maxOnlyParamValues(fakeMax, [{ id: "unknown", value: "x" }]), [], "values in no variant are not max-only");
  withMaxMode(false, () => {
    const mixed = chat({ model: "fake-max", params: [{ id: "context", value: "1m" }], reasoning_effort: "low" });
    assert.equal(sdkWouldUseMaxMode(fakeMax, [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "low" }]), false, "SDK rule alone would not fire");
    assert.throws(() => resolveCatalogModelSelection([fakeMax], mixed), is403);
    assert.throws(() => resolveCatalogModelSelection([fakeMax], chat({ model: "fake-max", variant: "Max", reasoning_effort: "low" })), is403);
    // Allowed: the same mix passes through unchanged.
  });
  const allowed = resolveCatalogModelSelection([fakeMax], chat({ model: "fake-max", params: [{ id: "context", value: "1m" }], reasoning_effort: "low" }));
  assert.deepEqual(paramsOf(allowed), { context: "1m", reasoning_effort: "low" });
});

test("N2: a default-variant max-only value with an incompatible explicit choice is rejected, not leaked", () => {
  const catalog = [
    {
      id: "m",
      parameters: [
        { id: "context", values: [{ value: "200k" }, { value: "1m" }] },
        { id: "fast", values: [{ value: "true" }, { value: "false" }] },
      ],
      variants: [
        { displayName: "Slow", params: [{ id: "context", value: "200k" }, { id: "fast", value: "false" }] },
        { displayName: "Long", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "fast", value: "true" }] },
      ],
    },
  ];
  withMaxMode(false, () => {
    // fast=true exists only on the max default; no non-max fallback keeps it → 403 (was 200 with context=1m).
    assert.throws(() => resolveCatalogModelSelection(catalog, chat({ model: "m", params: [{ id: "fast", value: "true" }] })), is403);
    assert.deepEqual(paramsOf(resolveCatalogModelSelection(catalog, chat({ model: "m" }))), { context: "200k", fast: "false" });
  });
});

test("N6: fallback choice on score ties does not depend on catalog order", () => {
  const variants = [
    { displayName: "A", params: [{ id: "context", value: "256k" }, { id: "reasoning_effort", value: "high" }] },
    { displayName: "B", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "high" }] },
    { displayName: "D", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }] },
  ];
  const base = {
    id: "tie",
    parameters: [
      { id: "context", values: [{ value: "200k" }, { value: "256k" }, { value: "1m" }] },
      { id: "reasoning_effort", values: [{ value: "high" }] },
    ],
  };
  withMaxMode(false, () => {
    const forward = paramsOf(resolveCatalogModelSelection([{ ...base, variants }], chat({ model: "tie" })));
    const reversed = paramsOf(resolveCatalogModelSelection([{ ...base, variants: [...variants].reverse() }], chat({ model: "tie" })));
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, { context: "200k", reasoning_effort: "high" }, "lexicographically smallest signature");
  });
});

test("N5: dropped soft hints are recorded (Responses reasoning.effort)", () => {
  withMaxMode(false, () => {
    const responses = parseResponsesRequest({ model: "fake-max", input: "hi", reasoning: { effort: "max" } });
    const selection = resolveCatalogModelSelection([fakeMax], responses);
    assert.equal(sdkWouldUseMaxMode(fakeMax, selection.params), false);
    assert.equal(wasHintSoftened(responses), true);
    const plain = parseResponsesRequest({ model: "fake-max", input: "hi", reasoning: { effort: "low" } });
    resolveCatalogModelSelection([fakeMax], plain);
    assert.equal(wasHintSoftened(plain), false);
  });
});

// --- N4-④: the gateway rule is checked against the rule cut from the installed SDK bundle -------

function sdkRuleFromBundle() {
  const pkgPath = join(import.meta.dirname, "..", "node_modules", "@cursor", "sdk", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bundle = readFileSync(join(dirname(pkgPath), "dist", "esm", "index.js"), "utf8");
  const marker = "const s=!0===t.maxMode||function(t,r){";
  const start = bundle.indexOf(marker);
  assert.ok(start >= 0, "SDK auto max-mode rule not found: re-review the max-mode guard for this SDK version");
  const fnStart = start + "const s=!0===t.maxMode||".length;
  const fnEnd = bundle.indexOf("}(n,t);return{...t,id:n.id,...s?{maxMode:!0}:{}}", fnStart);
  assert.ok(fnEnd > fnStart, "SDK max-mode rule shape changed");
  // eslint-disable-next-line no-new-func
  const rule = new Function(`return (${bundle.slice(fnStart, fnEnd + 1)});`)();
  return { version: pkg.version, rule: (model, params) => rule(model, { params }) };
}

test("N4: SDK pinned to 1.0.38 and the gateway rule equals the SDK's own function", () => {
  const { version, rule } = sdkRuleFromBundle();
  assert.equal(version, "1.0.38", "SDK upgraded: re-review the max-mode rule (src/cursor.ts sdkWouldUseMaxMode) before bumping this pin");
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const values = { context: ["200k", "1m", " 1m "], reasoning_effort: ["low", "high", "max"], fast: ["true", "false"] };
  for (let i = 0; i < 3000; i += 1) {
    const variants = Array.from({ length: rand(5) }, () => ({
      params: Object.entries(values)
        .filter(() => rand(3) > 0)
        .map(([id, list]) => ({ id, value: list[rand(list.length)] })),
      ...(rand(2) ? { isMaxMode: true } : {}),
    }));
    const model = { id: "m", variants };
    const params = Object.entries(values)
      .filter(() => rand(2) > 0)
      .map(([id, list]) => ({ id: rand(5) === 0 ? ` ${id}` : id, value: list[rand(list.length)] }));
    assert.equal(sdkWouldUseMaxMode(model, params), rule(model, params), JSON.stringify({ model, params }));
  }
});

// --- End to end -----------------------------------------------------------------------------------

function client(gateway) {
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  const post = (path, body, extra = {}) => fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return {
    chat: (body) => post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], ...body }),
    responses: (body) => post("/v1/responses", body),
    logs: async () =>
      (await (await fetch(`${gateway.baseUrl}/admin/api/logs`, { headers: { authorization: "Bearer it-admin-key" } })).json()).logs,
  };
}
const contentOf = async (res) => (await res.json()).choices[0].message.content;

test("N1/N3: SDK-resolved max mode is blocked when disallowed and logged as the actual value", { timeout: 30_000 }, async () => {
  let gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "agent" });
  try {
    const api = client(gateway);
    const res = await api.chat({ model: "fake-model" });
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    assert.match(gateway.output(), /sdk resolved max mode although the gateway selected a non-max variant/);
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "run" });
  try {
    const api = client(gateway);
    let res = await api.chat({ model: "fake-model" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    // Streaming: the run exists only after send, so headers are out; the error arrives as an SSE frame.
    res = await api.chat({ model: "fake-model", stream: true });
    const frames = parseSse(await res.text());
    assert.ok(frames.some((f) => f.data?.error?.code === "max_mode_not_allowed"), JSON.stringify(frames));
    assert.equal(frames.some((f) => typeof f.data?.choices?.[0]?.delta?.content === "string" && f.data.choices[0].delta.content !== ""), false, `no model text leaked: ${JSON.stringify(frames)}`);
    assert.match(gateway.output(), /sdk sent a max-mode run although max mode is disallowed; cancelling/);
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway({ FAKE_SDK_FORCE_MAX: "agent" });
  try {
    const api = client(gateway);
    assert.equal((await api.chat({ model: "fake-model" })).status, 200);
    const row = (await api.logs()).find((log) => log.model === "fake-model");
    assert.equal(row.max_mode, 1, "logs what the SDK actually resolved, not the gateway prediction");
  } finally {
    await gateway.stop();
  }
});

test("N2 e2e: context=1m + reasoning_effort=low is 403 on Chat and Responses when disallowed", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false" });
  const api = client(gateway);
  const params = [{ id: "context", value: "1m" }];
  try {
    for (const [name, send] of Object.entries({
      chat: () => api.chat({ model: "fake-max", params, reasoning_effort: "low" }),
      chat_stream: () => api.chat({ model: "fake-max", params, reasoning_effort: "low", stream: true }),
      responses: () => api.responses({ model: "fake-max", input: "hi", params, reasoning_effort: "low" }),
      responses_stream: () => api.responses({ model: "fake-max", input: "hi", params, reasoning_effort: "low", stream: true }),
    })) {
      const res = await send();
      assert.equal(res.status, 403, name);
      assert.match(res.headers.get("content-type") ?? "", /json/, `${name}: JSON error, not SSE`);
    }
  } finally {
    await gateway.stop();
  }
});

test("N4: key switch is asserted, and the resume-failure replay path stays non-max", { timeout: 30_000 }, async () => {
  let gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", CURSOR_API_KEY: "limited-first", CURSOR_API_KEYS: "good-key" });
  try {
    const res = await client(gateway).chat({ model: "fake-max", messages: [{ role: "user", content: "ECHO_KEY" }] });
    assert.equal(res.status, 200);
    assert.equal(await contentOf(res), "good-key", "first key was rate limited, the run moved to the second key");
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FAIL_RESUME: "1" });
  try {
    const api = client(gateway);
    let res = await api.chat({ model: "fake-max", conversation_id: "replay-1", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    res = await api.chat({
      model: "fake-max",
      conversation_id: "replay-1",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "PONG" },
        { role: "user", content: "ECHO_MAX" },
      ],
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(gateway.output(), /conversation resume failed, replaying full transcript/);
    const echo = JSON.parse(await contentOf(res));
    assert.equal(echo.sdk_max_mode, false);
    assert.deepEqual(Object.fromEntries(echo.params.map((p) => [p.id, p.value])), { context: "200k", reasoning_effort: "high" });
  } finally {
    await gateway.stop();
  }
});
