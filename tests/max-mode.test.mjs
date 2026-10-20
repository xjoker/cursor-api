// Max-mode guard: @cursor/sdk >= 1.0.38 turns max mode on by itself (params non-empty and every
// matching catalog variant isMaxMode). These tests pin what the gateway hands to the SDK.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configureMaxMode, resolveCatalogModelSelection, sdkWouldUseMaxMode } from "../dist/cursor.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { parseAnthropicMessagesRequest } from "../dist/anthropic.js";
import { loadConfig } from "../dist/config.js";
import { openDb } from "../dist/db.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const fakeMax = {
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
};
const maxOnly = {
  id: "fake-maxonly",
  displayName: "Fake Max Only",
  parameters: [{ id: "context", values: [{ value: "1m" }] }],
  variants: [{ displayName: "Fake Max Only", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }] }],
};
const plain = { id: "plain", displayName: "Plain", parameters: [], variants: [] };
const catalog = [fakeMax, maxOnly, plain];

const chat = (body) => parseChatCompletionsRequest({ messages: [{ role: "user", content: "hi" }], ...body });
const select = (request, options) => resolveCatalogModelSelection(catalog, request, options);
const paramsOf = (selection) => Object.fromEntries((selection.params ?? []).map((p) => [p.id, p.value]));

test("sdkWouldUseMaxMode mirrors the SDK rule", () => {
  assert.equal(sdkWouldUseMaxMode(fakeMax, undefined), false, "empty params never auto-enable");
  assert.equal(sdkWouldUseMaxMode(maxOnly, []), false);
  assert.equal(sdkWouldUseMaxMode(fakeMax, [{ id: "context", value: "1m" }]), true);
  assert.equal(sdkWouldUseMaxMode(fakeMax, [{ id: "context", value: " 1m " }]), true, "values are trimmed like the SDK");
  assert.equal(sdkWouldUseMaxMode(fakeMax, [{ id: "reasoning_effort", value: "high" }]), false, "a non-max variant also matches");
  assert.equal(sdkWouldUseMaxMode(fakeMax, [{ id: "context", value: "unknown" }]), false, "no matching variant");
  assert.equal(sdkWouldUseMaxMode(plain, [{ id: "x", value: "y" }]), false);
});

test("allow_max_mode=true (default) keeps behaviour and marks maxMode explicitly", () => {
  configureMaxMode({ allowMaxMode: true });
  const bare = select(chat({ model: "fake-max" }));
  assert.equal(bare.maxMode, true);
  assert.deepEqual(paramsOf(bare), { context: "1m", reasoning_effort: "high" });
  const nonMax = select(chat({ model: "fake-max", params: [{ id: "context", value: "200k" }] }));
  assert.equal("maxMode" in nonMax, false);
  assert.equal("maxMode" in select(chat({ model: "plain" })), false);
  assert.equal(select(chat({ model: "fake-maxonly" })).maxMode, true);
});

test("allow_max_mode=false falls back to the closest non-max variant for a bare model name", () => {
  configureMaxMode({ allowMaxMode: false });
  try {
    for (const model of ["fake-max", "FAKE-MAX", "fake-max-alias"]) {
      const selection = select(chat({ model }));
      assert.equal(selection.maxMode, undefined, model);
      assert.deepEqual(paramsOf(selection), { context: "200k", reasoning_effort: "high" }, model);
      assert.equal(sdkWouldUseMaxMode(fakeMax, selection.params), false, model);
    }
    // Explicit non-max choices are honoured.
    const low = select(chat({ model: "fake-max", reasoning_effort: "low" }));
    assert.deepEqual(paramsOf(low), { context: "200k", reasoning_effort: "low" });
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
});

test("allow_max_mode=false rejects every explicit route to a max-only variant", () => {
  configureMaxMode({ allowMaxMode: false });
  try {
    const cases = {
      params: chat({ model: "fake-max", params: [{ id: "context", value: "1m" }] }),
      variant: chat({ model: "fake-max", variant: "Max" }),
      reasoning_effort: chat({ model: "fake-max", reasoning_effort: "max" }),
      max_only_model: chat({ model: "fake-maxonly" }),
    };
    for (const [name, request] of Object.entries(cases)) {
      assert.throws(
        () => select(request),
        (error) => error.httpStatus === 403 && error.code === "max_mode_not_allowed" && error.param === "model",
        name,
      );
    }
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
});

test("per-request allowMaxMode=false overrides the gateway default; Anthropic effort=max hint is softened", () => {
  configureMaxMode({ allowMaxMode: true });
  assert.throws(() => select(chat({ model: "fake-maxonly" }), { allowMaxMode: false }), /max mode/);
  const anthropic = parseAnthropicMessagesRequest({
    model: "fake-max",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "max" },
  });
  assert.equal(select(anthropic).maxMode, true, "allowed: hint reaches the max variant");
  const softened = select(anthropic, { allowMaxMode: false });
  assert.equal(sdkWouldUseMaxMode(fakeMax, softened.params), false);
  assert.equal(paramsOf(softened).context, "200k");
});

test("allow_max_mode config parses from env and TOML, default true", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "maxmode-cfg-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  const toml = join(root, "data", "config", "gateway.toml");
  const base = ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"'];
  writeFileSync(toml, [...base, ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).allowMaxMode, true);
  assert.equal(loadConfig({ DATA_DIR: "data", ALLOW_MAX_MODE: "false" }, root).allowMaxMode, false);
  assert.throws(() => loadConfig({ DATA_DIR: "data", ALLOW_MAX_MODE: "maybe" }, root), /allow_max_mode|ALLOW_MAX_MODE/);
  writeFileSync(toml, [...base, "allow_max_mode = false", ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).allowMaxMode, false);
  assert.equal(loadConfig({ DATA_DIR: "data", ALLOW_MAX_MODE: "true" }, root).allowMaxMode, true, "env overrides TOML");
});

// --- End to end: what the fake SDK receives (it applies the SDK 1.0.38 rule itself) -------------

function client(gateway) {
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  return {
    chat: (body) => fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }),
    responses: (body) => fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", headers, body: JSON.stringify(body) }),
    messages: (body) =>
      fetch(`${gateway.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...headers, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      }),
  };
}

const echoOfChat = async (res) => JSON.parse((await res.json()).choices[0].message.content);
const echoOfChatStream = async (res) =>
  JSON.parse(
    parseSse(await res.text())
      .map((frame) => frame.data?.choices?.[0]?.delta?.content ?? "")
      .join(""),
  );
const echoOfResponses = async (res) =>
  JSON.parse((await res.json()).output.find((item) => item.type === "message").content[0].text);
const echoOfMessages = async (res) => JSON.parse((await res.json()).content.find((block) => block.type === "text").text);

test("ALLOW_MAX_MODE=false: no route sends max mode to the SDK", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({
    ALLOW_MAX_MODE: "false",
    MODEL_ALIASES: "claude-opus-*=fake-max",
    CURSOR_API_KEY: "limited-first",
    CURSOR_API_KEYS: "good-key",
  });
  const api = client(gateway);
  try {
    const seen = {};
    let res = await api.chat({ model: "fake-max", messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200, await res.clone().text());
    seen.chat = await echoOfChat(res);
    res = await api.chat({ model: "fake-max", stream: true, messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200);
    seen.chat_stream = await echoOfChatStream(res);
    res = await api.chat({ model: "claude-opus-4", messages: [{ role: "user", content: "ECHO_MAX" }] });
    seen.alias = await echoOfChat(res);
    res = await api.responses({ model: "fake-max", input: "ECHO_MAX" });
    assert.equal(res.status, 200);
    seen.responses = await echoOfResponses(res);
    res = await api.messages({ model: "fake-max", max_tokens: 32, output_config: { effort: "max" }, messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200, await res.clone().text());
    seen.anthropic_effort_max = await echoOfMessages(res);
    // New session then continued session (conversation_id → Agent.resume on the same key).
    res = await api.chat({ model: "fake-max", conversation_id: "conv-max", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    res = await api.chat({ model: "fake-max", conversation_id: "conv-max", messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200);
    seen.continued = await echoOfChat(res);
    for (const [route, echo] of Object.entries(seen)) {
      assert.equal(echo.id, "fake-max", route);
      assert.equal(echo.sdk_max_mode, false, `${route} must not reach max mode: ${JSON.stringify(echo)}`);
      assert.deepEqual(
        Object.fromEntries(echo.params.map((p) => [p.id, p.value])),
        { context: "200k", reasoning_effort: "high" },
        route,
      );
    }

    // Explicit max requests are rejected before any SDK call, OpenAI and Anthropic shapes.
    res = await api.chat({ model: "fake-max", reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "max_mode_not_allowed");
    assert.equal(body.error.type, "permission_error");
    assert.equal(body.error.param, "model");
    res = await api.chat({ model: "fake-maxonly", stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 403, "stream rejected with a JSON error, not mid-SSE");
    assert.match(res.headers.get("content-type") ?? "", /json/);
    res = await api.messages({ model: "fake-maxonly", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.type, "permission_error");
    res = await api.responses({ model: "fake-max", input: "hi", params: [{ id: "context", value: "1m" }] });
    assert.equal(res.status, 403);
  } finally {
    await gateway.stop();
  }
});

test("default (allow_max_mode=true): bare default-max model runs in max mode and is logged", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway();
  const api = client(gateway);
  try {
    let res = await api.chat({ model: "fake-max", messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200);
    const echo = await echoOfChat(res);
    assert.equal(echo.sdk_max_mode, true);
    res = await api.chat({ model: "fake-model", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    res = await api.chat({ model: "fake-maxonly", reasoning_effort: "turbo", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 400, "unrelated validation errors are unchanged");
    const logs = await (
      await fetch(`${gateway.baseUrl}/admin/api/logs`, { headers: { authorization: "Bearer it-admin-key" } })
    ).json();
    const byModel = Object.fromEntries(logs.logs.map((row) => [row.model, row.max_mode]));
    assert.equal(byModel["fake-max"], 1);
    assert.equal(byModel["fake-model"], 0);
    assert.equal(byModel["fake-maxonly"], null, "no run → unknown");
  } finally {
    await gateway.stop();
  }
});

test("request_logs gains a nullable max_mode column on existing databases", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "maxmode-mig-"));
  const legacy = new DatabaseSync(join(dir, "cursor-api.sqlite"));
  legacy.exec(`CREATE TABLE request_logs (id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL, model TEXT NOT NULL,
    stream INTEGER NOT NULL, http_status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, input_tokens INTEGER,
    output_tokens INTEGER, total_tokens INTEGER, error_code TEXT, created_at TEXT NOT NULL)`);
  legacy.close();
  const db = openDb(dir);
  const columns = db.prepare("PRAGMA table_info(request_logs)").all().map((row) => row.name);
  assert.ok(columns.includes("max_mode"));
  db.close();
});

test("retryable SDK ConfigurationError (1.0.38 catalog check) maps to 503, plain ones stay 400", async () => {
  const { ConfigurationError } = await import("@cursor/sdk");
  const { mapCursorError } = await import("../dist/cursor.js");
  const transient = mapCursorError(new ConfigurationError("The model catalog is unavailable. Retry the send.", { isRetryable: true }));
  assert.equal(transient.httpStatus, 503);
  assert.equal(transient.code, "upstream_unavailable");
  const invalid = mapCursorError(new ConfigurationError("bad model", { isRetryable: false }));
  assert.equal(invalid.httpStatus, 400);
});
