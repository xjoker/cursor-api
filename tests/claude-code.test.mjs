import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  anthropicEffortHint,
  estimateAnthropicInputTokens,
  parseAnthropicMessagesRequest,
} from "../dist/anthropic.js";
import { loadConfig } from "../dist/config.js";
import { parseModelAliases, resolveModelAlias } from "../dist/model-alias.js";
import { hashMessages } from "../dist/session.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

// Shape of a Claude Code 2.1 request (fields observed on the wire, values shortened).
function claudeCodeBody(messages, extra = {}) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 128000,
    stream: true,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    safeguards: [{ type: "dangerous_tool_use", classifier_context: { v: 1 } }],
    metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "s" }) },
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1" },
      { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    ],
    tools: [
      { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
    ],
    messages,
    ...extra,
  };
}

const firstTurn = [
  { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "CALL_TOOL<<Bash|{\"command\":\"echo hi\"}>>" }] },
  { role: "system", content: [{ type: "text", text: "Environment: linux", cache_control: { type: "ephemeral" } }] },
];

test("Claude Code requests parse: unknown beta fields ignored, system messages folded into the user turn", () => {
  const parsed = parseAnthropicMessagesRequest(claudeCodeBody(firstTurn, { brand_new_beta_field: { x: 1 } }));
  assert.equal(parsed.stream, true);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, "system");
  assert.equal(parsed.messages[1].role, "user");
  assert.match(parsed.messages[1].content, /\[system\]\nEnvironment: linux$/);
  assert.equal(parsed.reasoning_effort_hint, "medium");
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ["Bash", "Read"]);
});

test("folded history hashes the same on the first request and the tool-result round", () => {
  const first = parseAnthropicMessagesRequest(claudeCodeBody(firstTurn));
  const second = parseAnthropicMessagesRequest(
    claudeCodeBody([
      firstTurn[0],
      { role: "system", content: "Environment: linux" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "" },
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
          { type: "tool_use", id: "call_tool-Bash", name: "Bash", input: { command: "echo hi" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_tool-Bash", content: "hi", cache_control: { type: "ephemeral" } }] },
    ]),
  );
  assert.equal(hashMessages(second.messages.slice(0, 2)), hashMessages(first.messages));
  assert.equal(second.messages.at(-1).role, "tool");
  assert.deepEqual(second.messages[2].tool_calls.map((call) => call.name), ["Bash"]);
});

test("thinking and output_config map to effort hints", () => {
  assert.equal(anthropicEffortHint({ type: "adaptive" }, { effort: "max" }), "max");
  assert.equal(anthropicEffortHint({ type: "adaptive" }, undefined), undefined);
  assert.equal(anthropicEffortHint({ type: "enabled", budget_tokens: 1024 }), "low");
  assert.equal(anthropicEffortHint({ type: "enabled", budget_tokens: 8000 }), "medium");
  assert.equal(anthropicEffortHint({ type: "enabled", budget_tokens: 32000 }), "high");
  assert.equal(anthropicEffortHint({ type: "disabled" }), "minimal");
  assert.equal(anthropicEffortHint(undefined, {}), undefined);
});

test("model_aliases parse globs, keep order, and reject malformed entries", (context) => {
  const aliases = parseModelAliases("claude-haiku-*=fast-model; claude-*=composer-2.5\nexact=other");
  assert.equal(resolveModelAlias(aliases, "claude-haiku-4-5-20251001"), "fast-model");
  assert.equal(resolveModelAlias(aliases, "CLAUDE-OPUS-5-5"), "composer-2.5");
  assert.equal(resolveModelAlias(aliases, "exact"), "other");
  assert.equal(resolveModelAlias(aliases, "exactly"), "exactly");
  assert.equal(resolveModelAlias(aliases, "gpt-x.1"), "gpt-x.1");
  assert.equal(resolveModelAlias(parseModelAliases("a.b=c"), "aXb"), "aXb");
  assert.deepEqual(parseModelAliases(""), []);
  for (const bad of ["nope", "=x", "a=", "a=b*"]) {
    assert.throws(() => parseModelAliases(bad), /model_aliases/);
  }

  const root = makeTempDir(context, "cursor-api-cc-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"', 'model_aliases = "claude-*=composer-2.5"', ""].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(resolveModelAlias(cfg.modelAliases, "claude-sonnet-4-5"), "composer-2.5");
  assert.equal(cfg.anthropicCountTokens, "off");
  assert.equal(loadConfig({ DATA_DIR: "data", ANTHROPIC_COUNT_TOKENS: "estimate" }, root).anthropicCountTokens, "estimate");
  assert.throws(() => loadConfig({ DATA_DIR: "data", ANTHROPIC_COUNT_TOKENS: "exact" }, root), /ANTHROPIC_COUNT_TOKENS/);
  assert.throws(() => loadConfig({ DATA_DIR: "data", MODEL_ALIASES: "broken" }, root), /model_aliases/);
});

test("count_tokens estimate scales with content and ignores cache metadata", () => {
  const small = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "abcd".repeat(10) }] });
  assert.equal(small, 10);
  const cjk = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "你好世界" }] });
  assert.equal(cjk, 4);
  const withCache = estimateAnthropicInputTokens({
    system: [{ type: "text", text: "abcd".repeat(10), cache_control: { type: "ephemeral", ttl: "1h-long-string" } }],
    messages: [],
  });
  assert.equal(withCache, 10);
  const big = estimateAnthropicInputTokens(claudeCodeBody(firstTurn));
  assert.ok(big > small);
});

test("Claude Code flow over HTTP: aliases, folded system, parked tool round, count_tokens", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ MODEL_ALIASES: "claude-*=fake-model", ANTHROPIC_COUNT_TOKENS: "estimate" });
  const headers = {
    "x-api-key": CLIENT_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,some-future-beta-2027-01-01",
    "content-type": "application/json",
  };
  const post = (path, body) => fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const first = await post("/v1/messages?beta=true", claudeCodeBody(firstTurn));
    assert.equal(first.status, 200);
    const frames = parseSse(await first.text());
    assert.deepEqual(frames.slice(0, 2).map((f) => f.event), ["message_start", "ping"]);
    const toolStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block.type === "tool_use");
    assert.equal(toolStart.data.content_block.name, "Bash");
    const toolJson = frames.find((f) => f.event === "content_block_delta" && f.data.index === toolStart.data.index);
    assert.deepEqual(JSON.parse(toolJson.data.delta.partial_json), { command: "echo hi" });
    assert.equal(frames.find((f) => f.event === "message_delta").data.delta.stop_reason, "tool_use");

    const id = toolStart.data.content_block.id;
    const second = await post(
      "/v1/messages?beta=true",
      claudeCodeBody([
        firstTurn[0],
        { role: "system", content: "Environment: linux" },
        { role: "assistant", content: [{ type: "thinking", thinking: "pondering", signature: "" }, { type: "tool_use", id, name: "Bash", input: { command: "echo hi" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "hi" }] },
      ]),
    );
    assert.equal(second.status, 200);
    const text = parseSse(await second.text())
      .filter((f) => f.event === "content_block_delta" && f.data.delta.type === "text_delta")
      .map((f) => f.data.delta.text)
      .join("");
    assert.equal(text, "tool said: hi");
    assert.doesNotMatch(gateway.output(), /replaying tool results from transcript/);

    const count = await post("/v1/messages/count_tokens?beta=true", {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "abcd".repeat(25) }],
    });
    assert.equal(count.status, 200);
    assert.equal(count.headers.get("x-token-count-estimated"), "true");
    assert.deepEqual(await count.json(), { input_tokens: 25 });

    const unauth = await fetch(`${gateway.baseUrl}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).error.type, "authentication_error");
  } finally {
    await gateway.stop();
  }

  const off = await startFakeGateway();
  try {
    const res = await fetch(`${off.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": CLIENT_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.type, "not_found_error");
  } finally {
    await off.stop();
  }
});
