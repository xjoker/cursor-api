import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";

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
