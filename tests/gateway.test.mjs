import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { cancelledError } from "../dist/errors.js";
import { encodeNonStreamCompletion, encodeStreamChunk, parseChatCompletionsRequest } from "../dist/openai.js";
import {
  encodeNonStreamResponse,
  parseResponsesRequest,
  ResponsesStreamWriter,
} from "../dist/responses.js";

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

test("request logs are pruned when model bytes exceed max_detail_bytes", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-model-cap-"));
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
  for (let i = 0; i < 4; i += 1) {
    insertRequestLog(db, {
      id: `req-${i}`,
      api_key_id: "key-1",
      path: "/v1/chat/completions",
      model: "m".repeat(50),
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
      request_detail: null,
      response_detail: null,
    });
  }
  const { total, logs } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.ok(total <= 1);
  assert.equal(logs[0]?.id, "req-3");
});

test("request log byte cap uses UTF-8 bytes not character length", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-utf8-cap-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 200 });
  const now = new Date().toISOString();
  insertApiKey(db, {
    id: "key-1",
    name: "test",
    key_prefix: "cgk_test",
    key_digest: "digest",
    created_at: now,
    updated_at: now,
  });
  const payload = "你".repeat(40);
  assert.equal(payload.length, 40);
  assert.equal(Buffer.byteLength(payload, "utf8"), 120);
  for (let i = 0; i < 2; i += 1) {
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
      created_at: new Date(Date.now() - (2 - i) * 60_000).toISOString(),
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
  assert.equal(total, 1);
  assert.equal(logs[0]?.id, "req-1");
});

test("insertRequestLog truncates oversized model before persist", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs, MAX_LOG_MODEL_BYTES } =
    await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-model-trunc-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 268_435_456 });
  const now = new Date().toISOString();
  insertApiKey(db, {
    id: "key-1",
    name: "test",
    key_prefix: "cgk_test",
    key_digest: "digest",
    created_at: now,
    updated_at: now,
  });
  insertRequestLog(db, {
    id: "req-huge-model",
    api_key_id: "key-1",
    path: "/v1/chat/completions",
    model: "m".repeat(10_000),
    stream: 0,
    http_status: 200,
    duration_ms: 1,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    error_code: null,
    created_at: now,
    upstream_ms: 1,
    gateway_ms: 0,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    request_detail: null,
    response_detail: null,
  });
  const { logs } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.ok(Buffer.byteLength(logs[0]?.model ?? "", "utf8") <= MAX_LOG_MODEL_BYTES);
  assert.notEqual(logs[0]?.model?.length, 10_000);
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

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("chat completions accepts OpenAI image_url and OpenCode file/image parts", () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG}`;
  const imageUrl = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "color?" },
          { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
        ],
      },
    ],
  });
  assert.deepEqual(imageUrl.images, [{ data: TINY_PNG, mimeType: "image/png" }]);
  assert.equal(imageUrl.messages[0]?.content, "color?");

  const filePart = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "file", file: { filename: "swatch.png", file_data: dataUrl } },
        ],
      },
    ],
  });
  assert.deepEqual(filePart.images, [{ data: TINY_PNG, mimeType: "image/png" }]);

  const imagePart = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [{ type: "image", url: "https://example.test/red.png" }],
      },
    ],
  });
  assert.deepEqual(imagePart.images, [{ url: "https://example.test/red.png" }]);

  const skippedReasoning = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "hi" },
        ],
      },
    ],
  });
  assert.equal(skippedReasoning.messages[0]?.content, "hi");
  assert.equal(skippedReasoning.images, undefined);

  assert.throws(
    () =>
      parseChatCompletionsRequest({
        model: "grok-4.5",
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { filename: "notes.txt", file_data: "hello" } }],
          },
        ],
      }),
    (error) => error instanceof Error && error.message.includes("not an image"),
  );
  assert.throws(
    () =>
      parseChatCompletionsRequest({
        model: "grok-4.5",
        messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }],
      }),
    (error) => error instanceof Error && error.message.includes("audio"),
  );
});

test("stream and non-stream encode reasoning_content for OpenCode thinking blocks", () => {
  const chunk = encodeStreamChunk({
    id: "chatcmpl_test",
    created: 1,
    model: "grok-4.5",
    reasoning_content: "step 1",
  });
  assert.equal(chunk.choices[0].delta.reasoning_content, "step 1");
  assert.equal(Object.hasOwn(chunk.choices[0].delta, "content"), false);

  const body = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "grok-4.5",
    content: "red",
    usage: null,
    reasoning_content: "looked at pixels",
  });
  assert.equal(body.choices[0].message.content, "red");
  assert.equal(body.choices[0].message.reasoning_content, "looked at pixels");
});

test("sampling fields without Cursor primitives are rejected; max_tokens stays accepted", () => {
  assert.throws(
    () =>
      parseChatCompletionsRequest({
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
      }),
    (error) => error instanceof Error && error.message.includes("temperature"),
  );
  const parsed = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32000,
  });
  assert.equal(parsed.model, "grok-4.5");
});

test("only the last user message images are attached", () => {
  const parsed = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.test/old.png" } }],
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "color?" },
    ],
  });
  assert.equal(parsed.images, undefined);
  assert.equal(parsed.messages[0]?.images?.[0]?.url, "https://example.test/old.png");
  const latest = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.test/old.png" } }],
      },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          { type: "text", text: "now this" },
          { type: "image_url", image_url: { url: "https://example.test/new.png" } },
        ],
      },
    ],
  });
  assert.deepEqual(latest.images, [{ url: "https://example.test/new.png" }]);
});

test("tool_choice named function keeps only that tool", async () => {
  const parsed = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } },
    ],
    tool_choice: { type: "function", function: { name: "grep" } },
  });
  assert.deepEqual(parsed.tool_choice, { name: "grep" });
  const { filterToolsForChoice } = await import("../dist/session.js");
  assert.deepEqual(filterToolsForChoice(parsed.tools, parsed.tool_choice)?.map((tool) => tool.name), [
    "grep",
  ]);
});

test("unsupported tool routing controls are rejected", () => {
  const base = {
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    ],
  };
  assert.throws(
    () => parseChatCompletionsRequest({ ...base, tool_choice: "required" }),
    (error) => error instanceof Error && error.message.includes("tool_choice"),
  );
  assert.throws(
    () => parseChatCompletionsRequest({ ...base, parallel_tool_calls: false }),
    (error) => error instanceof Error && error.message.includes("parallel_tool_calls"),
  );
  assert.equal(parseChatCompletionsRequest({ ...base, parallel_tool_calls: true }).model, "grok-4.5");
});

test("chat turn validation rejects an unknown named tool before streaming", async () => {
  const parsed = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    tools: [
      { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    ],
    tool_choice: { type: "function", function: { name: "bash" } },
  });
  const { validateChatTurnRequest } = await import("../dist/session.js");
  assert.throws(
    () => validateChatTurnRequest(parsed),
    (error) => error instanceof Error && error.message.includes("not in tools"),
  );
});

test("tool results are validated atomically before parked calls resolve", async () => {
  const { applyToolResults } = await import("../dist/session.js");
  let resolved = 0;
  const session = {
    lastFlushed: ["call_1", "call_2"],
    parks: new Map([
      ["call_1", { resolve: () => { resolved += 1; }, reject: () => undefined }],
      ["call_2", { resolve: () => { resolved += 1; }, reject: () => undefined }],
    ]),
  };
  assert.throws(
    () =>
      applyToolResults(session, [
        { toolCallId: "call_1", content: "one" },
        { toolCallId: "call_1", content: "duplicate" },
        { toolCallId: "call_2", content: "two" },
      ]),
    (error) => error instanceof Error && error.message.includes("Duplicate tool_call_id"),
  );
  assert.equal(resolved, 0);
  assert.equal(session.parks.size, 2);
});

test("failed and continued runs clean up or reset session state", async () => {
  const { continueRun, raceTurn } = await import("../dist/session.js");
  let disposed = 0;
  const base = {
    apiKeyId: "key-1",
    agent: {
      agentId: "agent-1",
      [Symbol.asyncDispose]: async () => {
        disposed += 1;
      },
    },
    run: undefined,
    parks: new Map(),
    batch: [],
    batchReady: undefined,
    lastFlushed: [],
    awaitingClient: false,
    flushTimer: undefined,
    parkTimer: undefined,
    indexKeys: [],
    modelParams: undefined,
    text: "previous",
    thinking: "old thought",
    sink: undefined,
    lastRequestMessages: [],
    parkTimeoutMs: 1_000,
  };
  await assert.rejects(() =>
    raceTurn({
      ...base,
      waitPromise: Promise.reject(new Error("upstream failed")),
    }),
  );
  assert.equal(disposed, 1);

  const continued = { ...base, agent: { ...base.agent }, text: "first round", parks: new Map() };
  continued.waitPromise = Promise.resolve().then(() => ({
    text: continued.text,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    usageKnown: false,
    status: "finished",
    finish_reason: "stop",
  }));
  const result = await continueRun(continued, new AbortController().signal);
  assert.equal(result.text, "");
});

test("conversation_id is accepted on the body or in metadata", () => {
  const direct = parseChatCompletionsRequest({
    model: "grok-4.5",
    conversation_id: "thread-1",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(direct.conversation_id, "thread-1");
  const nested = parseChatCompletionsRequest({
    model: "grok-4.5",
    metadata: { conversation_id: "thread-2" },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(nested.conversation_id, "thread-2");
});

test("resolveTurnAction replays tool results when the park is gone", async () => {
  const { classifyChatTurn, resolveTurnAction } = await import("../dist/session.js");
  const toolTurn = classifyChatTurn([
    { role: "user", content: "list" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "bash", arguments: "{}" }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ]);
  assert.equal(
    resolveTurnAction({ turn: toolTurn, hasParkedSession: false }),
    "replay_transcript",
  );
  assert.equal(
    resolveTurnAction({ turn: toolTurn, hasParkedSession: true }),
    "continue_park",
  );
  const userTurn = classifyChatTurn([{ role: "user", content: "hi" }]);
  assert.equal(
    resolveTurnAction({
      turn: userTurn,
      hasParkedSession: false,
      conversationId: "c1",
      canResumeConversation: true,
    }),
    "resume_user",
  );
  assert.equal(
    resolveTurnAction({ turn: userTurn, hasParkedSession: false }),
    "new_user",
  );
});

test("PARK_TIMEOUT_MS and git_commit come from env or git HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-api-park-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      "park_timeout_ms = 12000",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "abcdef1234567890abcdef1234567890abcdef12\n");
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(cfg.parkTimeoutMs, 12000);
  assert.equal(cfg.gitCommit, "abcdef1234567890abcdef1234567890abcdef12");
  const fromEnv = loadConfig({ DATA_DIR: "data", GIT_COMMIT: "deadbeef" }, root);
  assert.equal(fromEnv.gitCommit, "deadbeef");
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

function grok45Catalog() {
  return {
    id: "grok-4.5",
    displayName: "Cursor Grok 4.5",
    parameters: [
      {
        id: "effort",
        displayName: "Effort",
        values: [
          { value: "low", displayName: "Low" },
          { value: "medium", displayName: "Medium" },
          { value: "high", displayName: "High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast\u200b" }],
      },
    ],
    variants: [
      { displayName: "Cursor Grok 4.5", params: [{ id: "effort", value: "low" }, { id: "fast", value: "false" }] },
      { displayName: "Cursor Grok 4.5", params: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }] },
      { displayName: "Cursor Grok 4.5", params: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }] },
      { displayName: "Cursor Grok 4.5", params: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }] },
      { displayName: "Cursor Grok 4.5", params: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }] },
      {
        displayName: "Cursor Grok 4.5",
        isDefault: true,
        params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
      },
    ],
  };
}

function chatRequest(overrides) {
  return {
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    includeUsage: false,
    ...overrides,
  };
}

test("variant high/low maps onto effort when Cursor repeats display names", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  const model = grok45Catalog();
  const high = resolveChatParams(model, chatRequest({ variant: "high" }));
  assert.deepEqual(high, [
    { id: "effort", value: "high" },
    { id: "fast", value: "true" },
  ]);
  const low = resolveChatParams(model, chatRequest({ variant: "low" }));
  assert.deepEqual(low, [
    { id: "effort", value: "low" },
    { id: "fast", value: "true" },
  ]);
});

test("variant fast toggles the fast param without changing default effort", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  const model = grok45Catalog();
  model.variants = model.variants.map((variant) =>
    variant.isDefault
      ? { ...variant, params: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }] }
      : variant,
  );
  const params = resolveChatParams(model, chatRequest({ variant: "fast" }));
  assert.deepEqual(params, [
    { id: "effort", value: "medium" },
    { id: "fast", value: "true" },
  ]);
});

test("unknown variant lists distinctive effort names instead of repeated display names", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  assert.throws(
    () => resolveChatParams(grok45Catalog(), chatRequest({ variant: "turbo" })),
    (error) =>
      error instanceof Error &&
      error.message.includes("Unknown variant 'turbo'") &&
      error.message.includes("high") &&
      error.message.includes("low") &&
      !error.message.includes("Cursor Grok 4.5, Cursor Grok 4.5"),
  );
});

test("shared catalog display name is not treated as the first variant", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  assert.throws(
    () => resolveChatParams(grok45Catalog(), chatRequest({ variant: "Cursor Grok 4.5" })),
    (error) => error instanceof Error && error.message.includes("Unknown variant"),
  );
});

test("unique variant display names still apply the full param set", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  const model = {
    id: "demo",
    displayName: "Demo",
    parameters: [
      {
        id: "effort",
        displayName: "Effort",
        values: [
          { value: "low", displayName: "Low" },
          { value: "high", displayName: "High" },
        ],
      },
    ],
    variants: [
      { displayName: "Quick", isDefault: true, params: [{ id: "effort", value: "low" }] },
      { displayName: "Deep", params: [{ id: "effort", value: "high" }] },
    ],
  };
  assert.deepEqual(resolveChatParams(model, chatRequest({ model: "demo", variant: "Deep" })), [
    { id: "effort", value: "high" },
  ]);
});

test("gpt-style reasoning=high is selected from variant high", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  const model = {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    parameters: [
      {
        id: "reasoning",
        displayName: "Reasoning",
        values: [
          { value: "none", displayName: "None" },
          { value: "high", displayName: "High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        displayName: "GPT-5.4",
        isDefault: true,
        params: [
          { id: "reasoning", value: "none" },
          { id: "fast", value: "true" },
        ],
      },
      {
        displayName: "GPT-5.4",
        params: [
          { id: "reasoning", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
    ],
  };
  assert.deepEqual(resolveChatParams(model, chatRequest({ model: "gpt-5.4", variant: "high" })), [
    { id: "reasoning", value: "high" },
    { id: "fast", value: "true" },
  ]);
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

function seedKey(id = "key-1") {
  const now = new Date().toISOString();
  return {
    id,
    name: "test",
    key_prefix: "cgk_test",
    key_digest: `digest-${id}`,
    created_at: now,
    updated_at: now,
  };
}

function seedLog(overrides) {
  return {
    api_key_id: "key-1",
    path: "/v1/chat/completions",
    model: "grok-4.5",
    stream: 0,
    http_status: 200,
    duration_ms: 1,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    error_code: null,
    created_at: new Date().toISOString(),
    upstream_ms: 1,
    gateway_ms: 0,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    request_detail: null,
    response_detail: null,
    ...overrides,
  };
}

test("conversations persist agent ids and are removed with the key", async () => {
  const { openDb, insertApiKey, deleteApiKey, upsertConversation, getConversationAgentId } =
    await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-conv-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, seedKey("key-1"));
  upsertConversation(db, "key-1", "thread-1", "agent-abc");
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), "agent-abc");
  upsertConversation(db, "key-1", "thread-1", "agent-xyz");
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), "agent-xyz");
  deleteApiKey(db, "key-1");
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), undefined);
});

test("deleteApiKey removes the key and keeps request logs", async () => {
  const { openDb, insertApiKey, insertRequestLog, listApiKeys, listRequestLogs, deleteApiKey } =
    await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-del-key-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, seedKey("key-1"));
  insertRequestLog(db, seedLog({ id: "req-keep" }));
  const deleted = deleteApiKey(db, "key-1");
  assert.equal(deleted?.id, "key-1");
  assert.equal(listApiKeys(db).length, 0);
  const { logs, total } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(logs[0]?.id, "req-keep");
  assert.equal(logs[0]?.key_name, null);
});

test("requestCallsByDay fills seven UTC days including zeros", async () => {
  const { openDb, insertApiKey, insertRequestLog, requestCallsByDay } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-calls-day-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, seedKey("key-1"));
  const today = new Date();
  const utcDay = (offset) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    return d.toISOString().slice(0, 10);
  };
  insertRequestLog(db, seedLog({ id: "req-today", created_at: `${utcDay(0)}T12:00:00.000Z` }));
  insertRequestLog(db, seedLog({ id: "req-today-2", created_at: `${utcDay(0)}T18:00:00.000Z` }));
  insertRequestLog(db, seedLog({ id: "req-3d", created_at: `${utcDay(3)}T08:00:00.000Z` }));
  const series = requestCallsByDay(db, 7);
  assert.equal(series.length, 7);
  assert.equal(series[0]?.day, utcDay(6));
  assert.equal(series[6]?.day, utcDay(0));
  assert.equal(series[6]?.count, 2);
  assert.equal(series.find((row) => row.day === utcDay(3))?.count, 1);
  assert.equal(series.find((row) => row.day === utcDay(1))?.count, 0);
});

test("system logs persist from logInfo and list with level filter", async () => {
  const { openDb, listSystemLogs, pruneSystemLogs } = await import("../dist/db.js");
  const { setSystemLogWriter, logInfo, logError } = await import("../dist/log.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-syslog-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  const { insertSystemLog } = await import("../dist/db.js");
  setSystemLogWriter((entry) => insertSystemLog(db, entry));
  try {
    logInfo("gateway listening", { port: 8787, api_key: "should-hide" });
    logError("cursor account lookup failed", { code: "upstream_error" });
    const all = listSystemLogs(db, { limit: 20, offset: 0 });
    assert.equal(all.total, 2);
    assert.equal(all.logs[0]?.message, "cursor account lookup failed");
    assert.equal(all.logs[1]?.message, "gateway listening");
    const infoOnly = listSystemLogs(db, { limit: 20, offset: 0, level: "info" });
    assert.equal(infoOnly.total, 1);
    const fields = JSON.parse(infoOnly.logs[0]?.fields ?? "{}");
    assert.equal(fields.api_key, "[redacted]");
    assert.equal(fields.port, 8787);
    const removed = pruneSystemLogs(db);
    assert.equal(removed, 0);
  } finally {
    setSystemLogWriter(undefined);
  }
});

test("responses parse maps string input, instructions, and previous_response_id", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    instructions: "be brief",
    input: "Reply PONG",
    previous_response_id: "resp_abc",
    temperature: 0.2,
    reasoning: { effort: "high" },
    text: { verbosity: "low" },
  });
  assert.equal(parsed.model, "composer-2.5");
  assert.equal(parsed.conversation_id, "resp_abc");
  assert.equal(parsed.reasoning_effort, "high");
  assert.equal(parsed.verbosity, "low");
  assert.equal(parsed.messages[0]?.role, "system");
  assert.equal(parsed.messages[0]?.content, "be brief");
  assert.equal(parsed.messages[1]?.role, "user");
  assert.equal(parsed.messages[1]?.content, "Reply PONG");
  assert.equal(parsed.includeUsage, true);
});

test("responses parse maps input_text / input_image and Responses tools", () => {
  const parsed = parseResponsesRequest({
    model: "grok-4.5",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "color?" },
          { type: "input_image", image_url: "https://example.test/red.png" },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        strict: false,
      },
    ],
    tool_choice: { type: "function", name: "bash" },
  });
  assert.equal(parsed.messages[0]?.content, "color?");
  assert.deepEqual(parsed.images, [{ url: "https://example.test/red.png" }]);
  assert.equal(parsed.tools?.[0]?.name, "bash");
  assert.deepEqual(parsed.tool_choice, { name: "bash" });
});

test("responses parse maps function_call items and synthesizes assistant for output-only rounds", () => {
  const withHistory = parseResponsesRequest({
    model: "composer-2.5",
    input: [
      { role: "user", content: "list files" },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "README.md" },
    ],
  });
  assert.equal(withHistory.messages[1]?.role, "assistant");
  assert.equal(withHistory.messages[1]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(withHistory.messages[2]?.role, "tool");
  assert.equal(withHistory.messages[2]?.tool_call_id, "call_1");

  const outputsOnly = parseResponsesRequest({
    model: "composer-2.5",
    previous_response_id: "resp_prev",
    input: [{ type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "ok" }] }],
  });
  assert.equal(outputsOnly.conversation_id, "resp_prev");
  assert.equal(outputsOnly.messages[0]?.role, "assistant");
  assert.equal(outputsOnly.messages[1]?.role, "tool");
  assert.equal(outputsOnly.messages[1]?.content, "ok");
});

test("responses reject hosted tools and unknown fields", () => {
  assert.throws(
    () =>
      parseResponsesRequest({
        model: "composer-2.5",
        input: "hi",
        tools: [{ type: "web_search" }],
      }),
    (error) => error instanceof Error && error.message.includes("web_search"),
  );
  assert.throws(
    () => parseResponsesRequest({ model: "composer-2.5", input: "hi", foo: 1 }),
    (error) => error instanceof Error && error.message.includes("Unknown field"),
  );
});

test("non-stream responses encode message and function_call output items", () => {
  const text = encodeNonStreamResponse({
    id: "resp_test",
    created: 1,
    model: "composer-2.5",
    content: "PONG",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.equal(text.object, "response");
  assert.equal(text.status, "completed");
  assert.equal(text.output[0].type, "message");
  assert.equal(text.output[0].content[0].type, "output_text");
  assert.equal(text.output[0].content[0].text, "PONG");
  assert.deepEqual(text.usage.input_tokens, 1);

  const tools = encodeNonStreamResponse({
    id: "resp_tools",
    created: 1,
    model: "composer-2.5",
    content: "",
    usage: null,
    tool_calls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    finish_reason: "tool_calls",
  });
  assert.equal(tools.status, "completed");
  assert.equal(tools.output[0].type, "function_call");
  assert.equal(tools.output[0].call_id, "call_1");
  assert.equal(tools.output[0].name, "bash");
  assert.equal(tools.usage.input_tokens, 0);
});

test("responses stream emits output_text and function_call events for OpenCode", async () => {
  const events = [];
  const writer = new ResponsesStreamWriter(
    async (event, data) => {
      events.push({ event, data });
    },
    { id: "resp_stream", created: 1, model: "composer-2.5" },
  );
  await writer.start();
  await writer.onThinking("plan");
  await writer.onText("PONG");
  await writer.onToolCalls([{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }]);
  await writer.complete({
    content: "PONG",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    tool_calls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    reasoning_content: "plan",
    finish_reason: "tool_calls",
  });
  const types = events.map((row) => row.event);
  assert.equal(types[0], "response.created");
  assert.ok(types.includes("response.reasoning_summary_text.delta"));
  assert.ok(types.includes("response.output_text.delta"));
  assert.ok(types.includes("response.function_call_arguments.delta"));
  assert.equal(types.at(-1), "response.completed");
  const textDelta = events.find((row) => row.event === "response.output_text.delta");
  assert.equal(textDelta?.data.delta, "PONG");
  const completed = events.at(-1)?.data.response;
  assert.equal(completed.output[0].type, "reasoning");
  assert.equal(completed.output[1].type, "message");
  assert.equal(completed.output[1].id, textDelta?.data.item_id);
  assert.equal(completed.output[2].type, "function_call");
  assert.equal(completed.output[2].call_id, "call_1");
});

test("writeSseEvent writes event and data lines", async () => {
  const { writeSseEvent } = await import("../dist/http.js");
  const chunks = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    closed: false,
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  await writeSseEvent(res, "response.created", { type: "response.created" });
  assert.equal(chunks[0], 'event: response.created\ndata: {"type":"response.created"}\n\n');
});

test("aliasLiveConversation is a no-op for the same id", async () => {
  const { aliasLiveConversation } = await import("../dist/session.js");
  assert.equal(aliasLiveConversation("key-1", "resp_1", "resp_1"), false);
});
