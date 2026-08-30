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

test("only production bootstraps a missing gateway.toml", () => {
  const productionRoot = mkdtempSync(join(tmpdir(), "cursor-api-bootstrap-"));
  const productionPath = join(productionRoot, "data", "config", "gateway.toml");
  assert.equal(existsSync(productionPath), false);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", DATA_DIR: "data" }, productionRoot),
    (error) => error instanceof Error && error.message.includes("cursor_api_key"),
  );
  assert.equal(existsSync(productionPath), true);
  const text = readFileSync(productionPath, "utf8");
  assert.match(text, /cursor_api_key = ""/);

  const developmentRoot = mkdtempSync(join(tmpdir(), "cursor-api-no-bootstrap-"));
  const developmentPath = join(developmentRoot, "data", "config", "gateway.toml");
  assert.throws(
    () => loadConfig({ DATA_DIR: "data" }, developmentRoot),
    (error) => error instanceof Error && error.message.includes("cursor_api_key"),
  );
  assert.equal(existsSync(developmentPath), false);
});

test("log policy applies defaults and TOML overrides, then rejects an invalid env override", () => {
  const defaultRoot = mkdtempSync(join(tmpdir(), "cursor-api-log-defaults-"));
  writeGatewayConfig(defaultRoot);
  const defaults = loadConfig({ DATA_DIR: "data" }, defaultRoot);
  assert.equal(defaults.logRetentionDays, 7);
  assert.equal(defaults.logDetailed, false);
  assert.equal(defaults.logMaxDetailBytes, 268_435_456);

  const overrideRoot = mkdtempSync(join(tmpdir(), "cursor-api-log-overrides-"));
  writeGatewayConfig(overrideRoot, [
    "[logs]",
    "retention_days = 7",
    "max_rows = 5000",
    "detailed = false",
  ]);
  const overrides = loadConfig({ DATA_DIR: "data" }, overrideRoot);
  assert.equal(overrides.logRetentionDays, 7);
  assert.equal(overrides.logMaxRows, 5000);
  assert.throws(
    () => loadConfig({ DATA_DIR: "data", LOG_DETAILED: "yes" }, overrideRoot),
    (error) =>
      error instanceof Error &&
      error.message.includes("environment variable LOG_DETAILED") &&
      error.message.includes('"yes"'),
  );
});

function writeGatewayConfig(root, extraLines = []) {
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      ...extraLines,
      "",
    ].join("\n"),
  );
}

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

test("max_detail_bytes counts UTF-8 bytes instead of characters", async () => {
  const { openDb, insertApiKey, insertRequestLog, listRequestLogs } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-detail-utf8-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 100 });
  insertApiKey(db, seedKey("key-1"));
  for (let i = 0; i < 2; i += 1) {
    insertRequestLog(db, seedLog({
      id: `req-utf8-${i}`,
      created_at: new Date(Date.now() + i).toISOString(),
      request_detail: "界".repeat(30),
    }));
  }
  const { total, logs } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(logs[0]?.id, "req-utf8-1");
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

test("truncateUtf8 preserves a valid UTF-8 boundary within the byte cap", async () => {
  const { truncateUtf8 } = await import("../dist/log.js");
  const out = truncateUtf8("界".repeat(30), 40);
  assert.ok(Buffer.byteLength(out, "utf8") <= 40);
  assert.equal(out.includes("�"), false);
  assert.match(out, /\[truncated\]$/);
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

test("non-stream responses encode usage, tools, and reasoning without inventing fields", () => {
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

  const withTools = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "composer-2.5",
    content: "",
    usage: null,
    tool_calls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    finish_reason: "tool_calls",
  });
  assert.equal(withTools.choices[0].finish_reason, "tool_calls");
  assert.equal(withTools.choices[0].message.content, null);
  assert.deepEqual(withTools.choices[0].message.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
    },
  ]);

  const withReasoning = encodeNonStreamCompletion({
    id: "chatcmpl_test",
    created: 1,
    model: "grok-4.5",
    content: "red",
    usage: null,
    reasoning_content: "looked at pixels",
  });
  assert.equal(withReasoning.choices[0].message.content, "red");
  assert.equal(withReasoning.choices[0].message.reasoning_content, "looked at pixels");
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

test("unsupported OpenAI compatibility controls fail closed", () => {
  const base = {
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    ],
  };
  for (const [field, body] of [
    ["functions", { ...base, functions: [{ name: "x" }] }],
    ["temperature", { ...base, temperature: 0.2 }],
    ["tool_choice", { ...base, tool_choice: "required" }],
    ["parallel_tool_calls", { ...base, parallel_tool_calls: false }],
  ]) {
    assert.throws(
      () => parseChatCompletionsRequest(body),
      (error) => error instanceof Error && error.message.includes(field),
    );
  }
  assert.equal(
    parseChatCompletionsRequest({ ...base, max_tokens: 32000, parallel_tool_calls: true }).model,
    "grok-4.5",
  );
});

test("stream responses encode tool-call and reasoning deltas", () => {
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

  const reasoning = encodeStreamChunk({
    id: "chatcmpl_test",
    created: 1,
    model: "grok-4.5",
    reasoning_content: "step 1",
  });
  assert.equal(reasoning.choices[0].delta.reasoning_content, "step 1");
  assert.equal(Object.hasOwn(reasoning.choices[0].delta, "content"), false);
});

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("image parsing accepts supported parts and only attaches the last user images", () => {
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

test("tool_choice selects one declared tool and rejects unknown names", async () => {
  const { filterToolsForChoice, validateChatTurnRequest } = await import("../dist/session.js");
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
  assert.deepEqual(filterToolsForChoice(parsed.tools, parsed.tool_choice)?.map((tool) => tool.name), [
    "grep",
  ]);

  const unknown = parseChatCompletionsRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    tools: [
      { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    ],
    tool_choice: { type: "function", function: { name: "bash" } },
  });
  assert.throws(
    () => validateChatTurnRequest(unknown),
    (error) => error instanceof Error && error.message.includes("not in tools"),
  );
});

test("tool results validate the whole batch and accept later parked calls", async () => {
  const { applyToolResults } = await import("../dist/session.js");
  const makeSession = (lastFlushed = ["call_1", "call_2"]) => {
    const resolved = [];
    return {
      resolved,
      session: {
        lastFlushed,
        parks: new Map([
          ["call_1", { resolve: (value) => { resolved.push(["call_1", value]); }, reject: () => undefined }],
          ["call_2", { resolve: (value) => { resolved.push(["call_2", value]); }, reject: () => undefined }],
        ]),
      },
    };
  };

  const missing = makeSession();
  assert.throws(
    () => applyToolResults(missing.session, [{ toolCallId: "call_1", content: "one" }]),
    (error) => error instanceof Error && error.message.includes("Missing tool results"),
  );
  assert.deepEqual(missing.resolved, []);
  assert.equal(missing.session.parks.size, 2);

  const duplicate = makeSession();
  assert.throws(
    () =>
      applyToolResults(duplicate.session, [
        { toolCallId: "call_1", content: "one" },
        { toolCallId: "call_1", content: "duplicate" },
        { toolCallId: "call_2", content: "two" },
      ]),
    (error) => error instanceof Error && error.message.includes("Duplicate tool_call_id"),
  );
  assert.deepEqual(duplicate.resolved, []);
  assert.equal(duplicate.session.parks.size, 2);

  const late = makeSession(["call_1"]);
  applyToolResults(late.session, [
    { toolCallId: "call_1", content: "one" },
    { toolCallId: "call_2", content: "two" },
  ]);
  assert.deepEqual(late.resolved, [["call_1", "one"], ["call_2", "two"]]);
  assert.equal(late.session.parks.size, 0);
});

test("a failed run disposes its agent and a continuation does not repeat prior text", async () => {
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

test("conversation_id accepts body or metadata values within the UTF-8 byte limit", () => {
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
  assert.throws(
    () =>
      parseChatCompletionsRequest({
        model: "grok-4.5",
        conversation_id: "界".repeat(171),
        messages: [{ role: "user", content: "hi" }],
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("conversation_id") &&
      error.message.includes("512 UTF-8 bytes"),
  );
});

test("chat turns are classified and routed by conversation state", async () => {
  const { classifyChatTurn, hashMessages, resolveTurnAction } = await import("../dist/session.js");
  const userTurn = classifyChatTurn([
    { role: "system", content: "sys" },
    { role: "user", content: "list" },
  ]);
  assert.equal(userTurn.kind, "user");
  assert.equal(userTurn.user.content, "list");

  const toolTurn = classifyChatTurn([
    { role: "system", content: "sys" },
    { role: "user", content: "list" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "bash", arguments: "{}" }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ]);
  assert.equal(toolTurn.kind, "tool_results");
  assert.equal(toolTurn.results[0]?.toolCallId, "call_1");
  assert.equal(hashMessages(toolTurn.stem), hashMessages(userTurn.stem.concat([userTurn.user])));
  assert.equal(
    resolveTurnAction({ turn: toolTurn, hasParkedSession: false }),
    "replay_transcript",
  );
  assert.equal(
    resolveTurnAction({ turn: toolTurn, hasParkedSession: true }),
    "continue_park",
  );
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

test("stream response setup runs only after conversation ownership is acquired", async () => {
  const { claimConversationRequest, withConversationClaim } = await import("../dist/session.js");
  const release = claimConversationRequest("key-1", "c1");
  let responseStarted = false;
  await assert.rejects(
    withConversationClaim("key-1", "c1", async () => {
      responseStarted = true;
    }),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      error.httpStatus === 409 &&
      error.code === "conversation_busy",
  );
  assert.equal(responseStarted, false);

  release?.();
  await withConversationClaim("key-1", "c1", async () => {
    responseStarted = true;
    assert.throws(
      () => claimConversationRequest("key-1", "c1"),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        error.code === "conversation_busy",
    );
  });
  assert.equal(responseStarted, true);

  const releaseAgain = claimConversationRequest("key-1", "c1");
  releaseAgain?.();
});

test("parked-session routing honors explicit IDs and image identity", async () => {
  const { hashMessages, resolveParkedRoute } = await import("../dist/session.js");
  assert.equal(
    resolveParkedRoute({
      conversationId: "c1",
      hasConversationParks: true,
      hasStemParks: true,
    }),
    "conversation",
  );
  assert.equal(
    resolveParkedRoute({
      conversationId: "c2",
      hasConversationParks: false,
      hasStemParks: true,
    }),
    undefined,
  );
  assert.equal(
    resolveParkedRoute({ hasConversationParks: false, hasStemParks: true }),
    "stem",
  );

  const first = [
    {
      role: "user",
      content: "describe",
      images: [{ data: "Zmlyc3Q=", mimeType: "image/png" }],
    },
  ];
  const second = [
    {
      role: "user",
      content: "describe",
      images: [{ data: "c2Vjb25k", mimeType: "image/png" }],
    },
  ];
  assert.notEqual(hashMessages(first), hashMessages(second));
});

test("configuration reads park timeout and gives GIT_COMMIT env precedence", () => {
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

test("toOpenAiToolCallId strips newlines and unsafe characters", async () => {
  const { toOpenAiToolCallId } = await import("../dist/session.js");
  const cleaned = toOpenAiToolCallId("call-abc-1\nfc_def_0");
  assert.equal(cleaned.includes("\n"), false);
  assert.match(cleaned, /^[A-Za-z0-9_-]+$/);
  assert.equal(toOpenAiToolCallId("call_ok"), "call_ok");
});

test("agent creation grants only MCP when client tools are present", async (context) => {
  const { Agent } = await import("@cursor/sdk");
  const { createLocalChatAgent } = await import("../dist/cursor.js");
  const calls = [];
  context.mock.method(Agent, "create", async (options) => {
    calls.push(options);
    return { agentId: `agent-${calls.length}` };
  });
  const workspaceDir = mkdtempSync(join(tmpdir(), "cursor-api-agent-tools-"));
  const base = { apiKey: "test-key", workspaceDir, model: { id: "grok-4.5" } };

  await createLocalChatAgent(base);
  assert.deepEqual(calls[0]?.tools, []);
  assert.equal(calls[0]?.local.customTools, undefined);

  const customTools = {
    grep: { inputSchema: { type: "object" }, execute: async () => "ok" },
  };
  await createLocalChatAgent({ ...base, customTools });
  assert.deepEqual(calls[1]?.tools, ["mcp"]);
  assert.equal(calls[1]?.local.customTools, customTools);
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

test("catalog selection rejects unknown models and resolves aliases", async () => {
  const { resolveCatalogModelSelection } = await import("../dist/cursor.js");
  assert.throws(
    () => resolveCatalogModelSelection([], chatRequest({ model: "missing-model" })),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      error.httpStatus === 404 &&
      error.code === "model_not_found",
  );
  assert.equal(
    resolveCatalogModelSelection(
      [{ id: "grok-4.5", displayName: "Grok", aliases: ["grok-latest"] }],
      chatRequest({ model: "grok-latest" }),
    ).id,
    "grok-4.5",
  );
});

test("repeated variant names resolve parameter shortcuts and reject ambiguous names", async () => {
  const { resolveChatParams } = await import("../dist/cursor.js");
  const model = grok45Catalog();
  for (const effort of ["high", "low"]) {
    assert.deepEqual(resolveChatParams(model, chatRequest({ variant: effort })), [
      { id: "effort", value: effort },
      { id: "fast", value: "true" },
    ]);
  }

  const fastModel = grok45Catalog();
  fastModel.variants = fastModel.variants.map((variant) =>
    variant.isDefault
      ? { ...variant, params: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }] }
      : variant,
  );
  assert.deepEqual(resolveChatParams(fastModel, chatRequest({ variant: "fast" })), [
    { id: "effort", value: "medium" },
    { id: "fast", value: "true" },
  ]);

  assert.throws(
    () => resolveChatParams(grok45Catalog(), chatRequest({ variant: "turbo" })),
    (error) =>
      error instanceof Error &&
      error.message.includes("Unknown variant 'turbo'") &&
      error.message.includes("high") &&
      error.message.includes("low") &&
      !error.message.includes("Cursor Grok 4.5, Cursor Grok 4.5"),
  );
  assert.throws(
    () => resolveChatParams(grok45Catalog(), chatRequest({ variant: "Cursor Grok 4.5" })),
    (error) => error instanceof Error && error.message.includes("Unknown variant"),
  );

  const gptModel = {
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
  assert.deepEqual(
    resolveChatParams(gptModel, chatRequest({ model: "gpt-5.4", variant: "high" })),
    [
      { id: "reasoning", value: "high" },
      { id: "fast", value: "true" },
    ],
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

test("conversation mappings update and key deletion retains audit logs", async () => {
  const {
    deleteApiKey,
    getConversationAgentId,
    insertApiKey,
    insertRequestLog,
    listApiKeys,
    listRequestLogs,
    openDb,
    upsertConversation,
  } = await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-conv-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, seedKey("key-1"));
  upsertConversation(db, "key-1", "thread-1", "agent-abc");
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), "agent-abc");
  upsertConversation(db, "key-1", "thread-1", "agent-xyz");
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), "agent-xyz");
  insertRequestLog(db, seedLog({ id: "req-keep" }));
  const deleted = deleteApiKey(db, "key-1");
  assert.equal(deleted?.id, "key-1");
  assert.equal(listApiKeys(db).length, 0);
  assert.equal(getConversationAgentId(db, "key-1", "thread-1"), undefined);
  const { logs, total } = listRequestLogs(db, { limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(logs[0]?.id, "req-keep");
  assert.equal(logs[0]?.key_name, null);
});

test("conversation mappings are capped per client key", async () => {
  const { openDb, insertApiKey, upsertConversation, getConversationAgentId } =
    await import("../dist/db.js");
  const root = mkdtempSync(join(tmpdir(), "cursor-api-conv-cap-"));
  const db = openDb(root, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, seedKey("key-1"));
  insertApiKey(db, seedKey("key-2"));
  db.prepare(
    `INSERT INTO conversations (api_key_id, conversation_id, agent_id, updated_at)
     VALUES ('key-2', 'other-thread', 'other-agent', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 0
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < 999
     )
     INSERT INTO conversations (api_key_id, conversation_id, agent_id, updated_at)
     SELECT 'key-1', printf('thread-%04d', value), 'agent-' || value, '2026-01-01T00:00:00.000Z'
     FROM sequence`,
  ).run();
  upsertConversation(db, "key-1", "thread-1000", "agent-1000");
  const count = db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE api_key_id = ?").get("key-1");
  assert.equal(Number(count?.count), 1_000);
  assert.equal(getConversationAgentId(db, "key-1", "thread-0000"), undefined);
  assert.equal(getConversationAgentId(db, "key-1", "thread-1000"), "agent-1000");
  assert.equal(getConversationAgentId(db, "key-2", "other-thread"), "other-agent");
});

test("the seven-day call series fills missing UTC days with zeros", async () => {
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

test("responses map Codex custom/namespace tools and skip unnamed hosted tools", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    input: "hi",
    client_metadata: { id: "codex" },
    extra_sdk_field: true,
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Edit files with a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: patch" },
      },
      {
        type: "namespace",
        name: "multi_agent_v1",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { type: "web_search", external_web_access: false },
    ],
  });
  assert.deepEqual(
    parsed.tools?.map((tool) => tool.name),
    ["exec_command", "apply_patch", "spawn_agent"],
  );
  assert.deepEqual(parsed.customToolNames, ["apply_patch"]);
  assert.deepEqual(parsed.tools?.[1]?.parameters?.required, ["content"]);
  assert.equal(parsed.tools?.[1]?.parameters?.properties?.content?.type, "string");
  assert.match(parsed.tools?.[1]?.description ?? "", /start: patch/);
});

test("responses accept Codex compact with parallel_tool_calls false and empty tools", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "hello" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "You are performing a CONTEXT CHECKPOINT COMPACTION." }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    store: false,
    client_metadata: { request_kind: "compaction" },
  });
  assert.equal(parsed.model, "composer-2.5");
  assert.equal(parsed.tools, undefined);
  assert.equal(parsed.messages.at(-1)?.role, "user");
});

test("responses merge Codex assistant text with function_call before tool outputs", async () => {
  const { validateChatTurnRequest } = await import("../dist/session.js");
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "check tools" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "looking up tools" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
      },
      { type: "function_call", call_id: "call_2", name: "get_goal", arguments: "{}" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "looking up tools" }],
      },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "function_call_output", call_id: "call_2", output: "{}" },
    ],
  });
  assert.equal(parsed.messages.at(-3)?.role, "assistant");
  assert.equal(parsed.messages.at(-3)?.content, "looking up tools");
  assert.deepEqual(
    parsed.messages.at(-3)?.tool_calls?.map((call) => call.name),
    ["exec_command", "get_goal"],
  );
  assert.equal(parsed.messages.at(-2)?.role, "tool");
  assert.equal(parsed.messages.at(-1)?.role, "tool");
  const turn = validateChatTurnRequest(parsed);
  assert.equal(turn.kind, "tool_results");
});

test("responses parse custom_tool_call items", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    input: [
      { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "ok" },
    ],
  });
  assert.equal(parsed.messages[0]?.role, "assistant");
  assert.equal(parsed.messages[0]?.tool_calls?.[0]?.name, "apply_patch");
  assert.equal(
    parsed.messages[0]?.tool_calls?.[0]?.arguments,
    JSON.stringify({ content: "*** Begin Patch\n" }),
  );
  assert.equal(parsed.messages[1]?.role, "tool");
  assert.equal(parsed.messages[1]?.content, "ok");
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

  const custom = encodeNonStreamResponse({
    id: "resp_custom",
    created: 1,
    model: "composer-2.5",
    content: "",
    usage: null,
    tool_calls: [
      {
        id: "call_p",
        name: "apply_patch",
        arguments: JSON.stringify({ content: "*** Begin Patch\n" }),
      },
    ],
    finish_reason: "tool_calls",
    customToolNames: ["apply_patch"],
  });
  assert.equal(custom.output[0].type, "custom_tool_call");
  assert.equal(custom.output[0].call_id, "call_p");
  assert.equal(custom.output[0].name, "apply_patch");
  assert.equal(custom.output[0].input, "*** Begin Patch\n");
  assert.equal(custom.output[0].arguments, undefined);
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

test("responses stream emits custom_tool_call_input events for Codex apply_patch", async () => {
  const events = [];
  const writer = new ResponsesStreamWriter(
    async (event, data) => {
      events.push({ event, data });
    },
    { id: "resp_custom_stream", created: 1, model: "composer-2.5" },
    new Set(["apply_patch"]),
  );
  await writer.start();
  await writer.onToolCalls([
    {
      id: "call_p",
      name: "apply_patch",
      arguments: JSON.stringify({ content: "*** Begin Patch\n" }),
    },
  ]);
  await writer.complete({
    content: "",
    usage: null,
    tool_calls: [
      {
        id: "call_p",
        name: "apply_patch",
        arguments: JSON.stringify({ content: "*** Begin Patch\n" }),
      },
    ],
    finish_reason: "tool_calls",
  });
  const types = events.map((row) => row.event);
  assert.ok(types.includes("response.custom_tool_call_input.delta"));
  assert.ok(types.includes("response.custom_tool_call_input.done"));
  assert.ok(!types.includes("response.function_call_arguments.delta"));
  const added = events.find((row) => row.event === "response.output_item.added");
  assert.equal(added?.data.item.type, "custom_tool_call");
  assert.equal(added?.data.item.input, "");
  const delta = events.find((row) => row.event === "response.custom_tool_call_input.delta");
  assert.equal(delta?.data.delta, "*** Begin Patch\n");
  assert.equal(delta?.data.call_id, "call_p");
  const done = events.find((row) => row.event === "response.output_item.done");
  assert.equal(done?.data.item.type, "custom_tool_call");
  assert.equal(done?.data.item.input, "*** Begin Patch\n");
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
