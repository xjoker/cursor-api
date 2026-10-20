// Cost metadata is persisted independently from detailed request/response snapshots.
// The fake SDK cost knobs are intentionally supplied by this test and never reach Cursor.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const ADMIN = { authorization: "Bearer it-admin-key" };
const JSON_HEADERS = {
  authorization: `Bearer ${CLIENT_KEY}`,
  "content-type": "application/json",
};

async function post(gateway, path, body) {
  return fetch(`${gateway.baseUrl}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function logs(gateway) {
  const response = await fetch(`${gateway.baseUrl}/admin/api/logs?limit=20`, { headers: ADMIN });
  assert.equal(response.status, 200);
  return response.json();
}

async function oneChatLog(extraEnv = {}) {
  const gateway = await startFakeGateway({ LOG_DETAILED: "false", ...extraEnv });
  try {
    const response = await post(gateway, "/v1/chat/completions", {
      model: "fake-model",
      messages: [{ role: "user", content: "cost probe" }],
    });
    assert.equal(response.status, 200, await response.text());
    const body = await logs(gateway);
    assert.equal(body.total, 1);
    const row = body.logs[0];
    const detail = await fetch(`${gateway.baseUrl}/admin/api/logs/${encodeURIComponent(row.id)}`, {
      headers: ADMIN,
    });
    assert.equal(detail.status, 200);
    return { row, detail: await detail.json() };
  } finally {
    await gateway.stop();
  }
}

test("detailed=false keeps Agent cost snapshots for Chat and Responses in admin logs", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({
    LOG_DETAILED: "false",
    FAKE_SDK_COST_RAW_CENTS: "12.5",
    FAKE_SDK_COST_CHARGED_CENTS: "8.25",
  });
  try {
    const chat = await post(gateway, "/v1/chat/completions", {
      model: "fake-model",
      messages: [{ role: "user", content: "chat cost" }],
    });
    assert.equal(chat.status, 200, await chat.text());
    const responses = await post(gateway, "/v1/responses", {
      model: "fake-model",
      input: "responses cost",
    });
    assert.equal(responses.status, 200, await responses.text());

    const listed = await logs(gateway);
    assert.equal(listed.total, 2);
    for (const row of listed.logs) {
      assert.deepEqual(
        [row.raw_cost_cents, row.charged_cents, row.cost_scope],
        [12.5, 8.25, "agent_total"],
        row.path,
      );
      assert.equal(row.has_detail, false, "cost is independent from detailed request logging");

      const detail = await fetch(`${gateway.baseUrl}/admin/api/logs/${encodeURIComponent(row.id)}`, {
        headers: ADMIN,
      });
      assert.equal(detail.status, 200);
      const full = await detail.json();
      assert.equal(full.request_detail, null);
      assert.equal(full.response_detail, null);
      assert.deepEqual(
        [full.raw_cost_cents, full.charged_cents, full.cost_scope],
        [12.5, 8.25, "agent_total"],
        row.path,
      );
    }
    assert.deepEqual(
      listed.logs.map((row) => row.path).sort(),
      ["/v1/chat/completions", "/v1/responses"],
    );
  } finally {
    await gateway.stop();
  }
});

test("unknown cost stays null while an explicit zero cost stays zero", { timeout: 60_000 }, async () => {
  const unknown = await oneChatLog();
  assert.deepEqual(
    [unknown.row.raw_cost_cents, unknown.row.charged_cents, unknown.row.cost_scope],
    [null, null, null],
  );
  assert.deepEqual(
    [unknown.detail.raw_cost_cents, unknown.detail.charged_cents, unknown.detail.cost_scope],
    [null, null, null],
  );

  const zero = await oneChatLog({ FAKE_SDK_COST_RAW_CENTS: "0", FAKE_SDK_COST_CHARGED_CENTS: "0" });
  assert.deepEqual([zero.row.raw_cost_cents, zero.row.charged_cents, zero.row.cost_scope], [0, 0, "agent_total"]);
});

test("NaN, Infinity, and negative SDK costs are rejected at the log boundary", { timeout: 120_000 }, async () => {
  for (const value of ["NaN", "Infinity", "-1"]) {
    const result = await oneChatLog({
      FAKE_SDK_COST_RAW_CENTS: value,
      FAKE_SDK_COST_CHARGED_CENTS: value,
    });
    assert.deepEqual(
      [result.row.raw_cost_cents, result.row.charged_cents, result.row.cost_scope],
      [null, null, null],
      value,
    );
  }
});

test("v12 adds nullable cost columns and does not repeat the v11 cache-inclusive migration", async (context) => {
  const dir = makeTempDir(context, "cost-log-migrate-");
  const dbPath = join(dir, "cursor-api.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key_prefix TEXT NOT NULL,
      key_digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
      request_limit INTEGER NOT NULL DEFAULT 0, used_requests INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE request_logs (
      id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL, model TEXT NOT NULL,
      stream INTEGER NOT NULL, http_status INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, error_code TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO api_keys (id, name, key_prefix, key_digest, created_at, updated_at)
      VALUES ('k', 'legacy', 'k', 'digest', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO request_logs (
      id, api_key_id, model, stream, http_status, duration_ms, input_tokens,
      output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, created_at
    ) VALUES ('old', 'k', 'm', 0, 200, 1, 100, 2, 105, 4, 1, '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 10;
  `);
  legacy.close();

  const { openDb, SCHEMA_VERSION } = await import("../dist/db.js");
  let db = openDb(dir, { retentionDays: 10_000, maxRows: 100, maxDetailBytes: 1_048_576 });
  assert.equal(SCHEMA_VERSION, 12);
  const columns = db.prepare("PRAGMA table_info(request_logs)").all();
  for (const name of ["raw_cost_cents", "charged_cents", "cost_scope"]) {
    const column = columns.find((item) => item.name === name);
    assert.ok(column, name);
    assert.equal(column.notnull, 0, name);
  }
  assert.equal(db.prepare("SELECT input_tokens FROM request_logs WHERE id = 'old'").get().input_tokens, 105);
  assert.deepEqual(
    { ...db.prepare("SELECT raw_cost_cents, charged_cents, cost_scope, request_detail, response_detail FROM request_logs WHERE id = 'old'").get() },
    { raw_cost_cents: null, charged_cents: null, cost_scope: null, request_detail: null, response_detail: null },
  );
  db.close();

  db = openDb(dir, { retentionDays: 10_000, maxRows: 100, maxDetailBytes: 1_048_576 });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 12);
    assert.equal(db.prepare("SELECT input_tokens FROM request_logs WHERE id = 'old'").get().input_tokens, 105);
  } finally {
    db.close();
  }
});
