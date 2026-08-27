import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { cancelledError } from "../dist/errors.js";
import { encodeNonStreamCompletion, encodeStreamChunk, parseChatCompletionsRequest } from "../dist/openai.js";

test("TOML trailing comments and hashes inside strings are valid", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-toml-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'host = "127.0.0.1" # listen',
      "port = 8787 # gateway",
      "# whole line",
      'cursor_api_key = "ab#cd"',
      'admin_access_key = "admin-key"',
      'api_key_pepper = "pepper"',
      "",
    ].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(cfg.gatewayHost, "127.0.0.1");
  assert.equal(cfg.gatewayPort, 8787);
  assert.equal(cfg.cursorApiKey, "ab#cd");
});

test("production auto-creates empty gateway.toml when missing", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-bootstrap-"));
  const configPath = join(root, "data", "config", "gateway.toml");
  assert.equal(existsSync(configPath), false);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", DATA_DIR: "data" }, root),
    (error) => error instanceof Error && error.message.includes("cursor_api_key"),
  );
  assert.equal(existsSync(configPath), true);
  const text = readFileSync(configPath, "utf8");
  assert.match(text, /cursor_api_key = ""/);
});

test("non-production does not auto-create gateway.toml", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-no-bootstrap-"));
  const configPath = join(root, "data", "config", "gateway.toml");
  assert.throws(
    () => loadConfig({ DATA_DIR: "data" }, root),
    (error) => error instanceof Error && error.message.includes("cursor_api_key"),
  );
  assert.equal(existsSync(configPath), false);
});

test("TOML [logs] section sets retention and row cap", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-logs-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      "[logs]",
      "retention_days = 7",
      "max_rows = 5000",
      "",
    ].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(cfg.logRetentionDays, 7);
  assert.equal(cfg.logMaxRows, 5000);
});

test("TOML detailed flag defaults to false", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-detailed-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      "",
    ].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(cfg.logRetentionDays, 7);
  assert.equal(cfg.logDetailed, false);
  assert.equal(cfg.logMaxDetailBytes, 268_435_456);
});

test("invalid LOG_DETAILED names the environment variable", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-log-env-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      "[logs]",
      "detailed = false",
      "",
    ].join("\n"),
  );
  assert.throws(
    () => loadConfig({ DATA_DIR: "data", LOG_DETAILED: "yes" }, root),
    (error) =>
      error instanceof Error &&
      error.message.includes("environment variable LOG_DETAILED") &&
      error.message.includes('"yes"'),
  );
});

test("request logs are pruned to max_rows", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-prune-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 2, maxDetailBytes: 268_435_456 });
  const now = new Date().toISOString();
  insertApiKey(db, {
    id: "key-1",
    name: "test",
    key_prefix: "cgk_test",
    key_digest: "digest",
    created_at: now,
    updated_at: now,
  });
  const base = {
    api_key_id: "key-1",
    path: "/v1/chat/completions",
    model: "composer-2.5",
    stream: 0,
    http_status: 200,
    duration_ms: 1,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    error_code: null,
    upstream_ms: 1,
    gateway_ms: 0,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    request_detail: null,
    response_detail: null,
  };
  for (let i = 0; i < 4; i += 1) {
    insertRequestLog(db, {
      ...base,
      id: `req-${i}`,
      created_at: new Date(Date.now() - (4 - i) * 60_000).toISOString(),
    });
  }
  const { total, logs } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.equal(total, 2);
  assert.deepEqual(
    logs.map((row) => row.id),
    ["req-3", "req-2"],
  );
});

test("request logs are pruned by max_detail_bytes", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-detail-cap-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 80 });
  const now = new Date().toISOString();
  insertApiKey(db, {
    id: "key-1",
    name: "test",
    key_prefix: "cgk_test",
    key_digest: "digest",
    created_at: now,
    updated_at: now,
  });
  const payload = "x".repeat(50);
  for (let i = 0; i < 4; i += 1) {
    insertRequestLog(db, {
      id: `req-${i}`,
      api_key_id: "key-1",
      path: "/v1/chat/completions",
      model: "composer-2.5",
      stream: 0,
      http_status: 200,
      duration_ms: 1,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      error_code: null,
      created_at: new Date(Date.now() - (4 - i) * 60_000).toISOString(),
      upstream_ms: 1,
      gateway_ms: 0,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      request_detail: payload,
      response_detail: null,
    });
  }
  const { total, logs } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.ok(total <= 1);
  assert.equal(logs[0]?.id, "req-3");
});

test("sqlite database file is owner-readable only when chmod works", async () => {
  const { openDb } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-chmod-"));
  openDb(root, { retentionDays: 7, maxRows: 1000, maxDetailBytes: 1_048_576 });
  const mode = statSync(join(root, "cursor-api.sqlite")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("truncateUtf8 is O(n) for megabyte inputs", async () => {
  const { truncateUtf8 } = await import("../dist/log.js");
  const text = "a".repeat(1_000_000);
  const started = Date.now();
  const out = truncateUtf8(text, 65_536);
  const elapsed = Date.now() - started;
  assert.ok(Buffer.byteLength(out, "utf8") <= 65_536);
  assert.match(out, /\[truncated\]$/);
  assert.ok(elapsed < 200, `truncateUtf8 took ${elapsed}ms`);
});

test("writeSse resolves when response is already closed", async () => {
  const { writeSse } = await import("../dist/http.js");
  let drainWait = false;
  const res = {
    destroyed: false,
    writableEnded: true,
    closed: true,
    write() {
      return false;
    },
    once(event, listener) {
      if (event === "drain") drainWait = true;
      return this;
    },
    off() {
      return this;
    },
  };
  await writeSse(res, "[DONE]");
  assert.equal(drainWait, false);
});

test("stream must be a boolean when present", () => {
  const base = {
    model: "composer-2.5",
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(parseChatCompletionsRequest(base).stream, false);
  assert.equal(parseChatCompletionsRequest({ ...base, stream: true }).stream, true);
  assert.throws(
    () => parseChatCompletionsRequest({ ...base, stream: "true" }),
    (error) => error instanceof Error && error.message.includes("stream"),
  );
  assert.throws(
    () => parseChatCompletionsRequest({ ...base, stream: 1 }),
    (error) => error instanceof Error && error.message.includes("stream"),
  );
});

test("non-stream completion omits usage when unknown", () => {
  const without = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    content: "hi",
    usage: null,
  });
  assert.equal(Object.hasOwn(without, "usage"), false);

  const withUsage = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    content: "hi",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.deepEqual(withUsage.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
});

test("cancelledError maps to HTTP 499", () => {
  const error = cancelledError();
  assert.equal(error.httpStatus, 499);
  assert.equal(error.code, "cancelled");
  assert.equal(error.openaiType, "cancelled");
});

test("chat completions accepts OpenAI tools and tool role", () => {
  const parsed = parseChatCompletionsRequest({
    model: "composer-2.5",
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "README.md" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ],
  });
  assert.equal(parsed.tools?.[0]?.name, "bash");
  assert.equal(parsed.messages[1]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(parsed.messages[2]?.role, "tool");
  assert.equal(parsed.messages[2]?.tool_call_id, "call_1");
});

test("legacy functions field is still rejected", () => {
  assert.throws(
    () =>
      parseChatCompletionsRequest({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
        functions: [{ name: "x" }],
      }),
    (error) => error instanceof Error && error.message.includes("functions"),
  );
});

test("non-stream completion encodes tool_calls", () => {
  const body = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    content: "",
    usage: null,
    tool_calls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    finish_reason: "tool_calls",
  });
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.content, null);
  assert.deepEqual(body.choices[0].message.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
    },
  ]);
});

test("stream chunk encodes tool_calls deltas", () => {
  const chunk = encodeStreamChunk({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    tool_calls: [{ index: 0, id: "call_1", name: "bash", arguments: "" }],
  });
  assert.deepEqual(chunk.choices[0].delta.tool_calls, [
    {
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "bash", arguments: "" },
    },
  ]);
  const done = encodeStreamChunk({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    finish_reason: "tool_calls",
  });
  assert.equal(done.choices[0].finish_reason, "tool_calls");
});

test("identical conversation prefixes hash to the same stem", async () => {
  const { classifyChatTurn, hashMessages } = await import("../dist/session.js");
  const sys = { role: "system", content: "sys" };
  const ok = { role: "assistant", content: "OK" };
  const prefix = [sys, { role: "user", content: "Reply with only OK." }, ok];
  const nextC = classifyChatTurn([...prefix, { role: "user", content: "secret C" }]);
  const nextD = classifyChatTurn([...prefix, { role: "user", content: "secret D" }]);
  assert.equal(nextC.kind, "user");
  assert.equal(nextD.kind, "user");
  assert.equal(hashMessages(nextC.stem), hashMessages(nextD.stem));
});

test("missingFlushedToolResults only requires IDs already sent to the client", async () => {
  const { missingFlushedToolResults } = await import("../dist/session.js");
  assert.deepEqual(missingFlushedToolResults(["call_a"], ["call_a"]), []);
  assert.deepEqual(missingFlushedToolResults(["call_a", "call_b"], ["call_a"]), ["call_b"]);
  assert.deepEqual(missingFlushedToolResults(["call_a"], ["call_a", "call_late"]), []);
});

test("toOpenAiToolCallId strips newlines and unsafe characters", async () => {
  const { toOpenAiToolCallId } = await import("../dist/session.js");
  const cleaned = toOpenAiToolCallId("call-abc-1\nfc_def_0");
  assert.equal(cleaned.includes("\n"), false);
  assert.match(cleaned, /^[A-Za-z0-9_-]+$/);
  assert.equal(toOpenAiToolCallId("call_ok"), "call_ok");
});

test("localChatAgentTools enables mcp only when client tools exist", async () => {
  const { localChatAgentTools } = await import("../dist/cursor.js");
  assert.deepEqual(localChatAgentTools(false), []);
  assert.deepEqual(localChatAgentTools(true), ["mcp"]);
});

test("classifyChatTurn splits user vs tool result rounds", async () => {
  const { classifyChatTurn, hashMessages } = await import("../dist/session.js");
  const userTurn = classifyChatTurn([
    { role: "system", content: "sys" },
    { role: "user", content: "list files" },
  ]);
  assert.equal(userTurn.kind, "user");
  assert.equal(userTurn.user.content, "list files");

  const toolTurn = classifyChatTurn([
    { role: "system", content: "sys" },
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", name: "bash", arguments: "{}" }],
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ]);
  assert.equal(toolTurn.kind, "tool_results");
  assert.equal(toolTurn.results[0]?.toolCallId, "call_1");
  assert.equal(hashMessages(toolTurn.stem), hashMessages(userTurn.stem.concat([userTurn.user])));
});
