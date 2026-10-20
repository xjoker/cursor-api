// Request-log pruning preserves all three hard limits and chooses old rows deterministically.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const KEY = {
  id: "k",
  name: "test",
  key_prefix: "cgk_test",
  key_digest: "digest",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function insertStatement(db) {
  return db.prepare(`
    INSERT INTO request_logs (
      id, api_key_id, path, model, stream, http_status, duration_ms,
      input_tokens, output_tokens, total_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, error_code, created_at,
      upstream_ms, gateway_ms, request_detail, response_detail
    ) VALUES (?, 'k', '/v1/chat/completions', ?, 0, 200, 1,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 1, 0, ?, ?)
  `);
}

function addRows(db, rows) {
  const insert = insertStatement(db);
  for (const row of rows) {
    insert.run(row.id, row.model ?? "m", row.created_at, row.request_detail ?? null, row.response_detail ?? null);
  }
}

async function openWithPolicy(context, policy) {
  const { insertApiKey, openDb } = await import("../dist/db.js");
  const db = openDb(makeTempDir(context, "log-prune-"), policy);
  insertApiKey(db, KEY);
  return db;
}

test("pruning removes expired rows first, then oldest rows to maxRows", async (context) => {
  const { pruneRequestLogs } = await import("../dist/db.js");
  const now = Date.now();
  const db = await openWithPolicy(context, {
    retentionDays: 1,
    maxRows: 2,
    maxDetailBytes: 1_048_576,
  });
  try {
    addRows(db, [
      { id: "expired", created_at: new Date(now - 2 * 86_400_000).toISOString() },
      { id: "oldest-live", created_at: new Date(now - 2 * 3_600_000).toISOString() },
      { id: "middle-live", created_at: new Date(now - 3_600_000).toISOString() },
      { id: "newest-live", created_at: new Date(now).toISOString() },
    ]);
    assert.equal(pruneRequestLogs(db), 2);
    assert.deepEqual(
      db.prepare("SELECT id FROM request_logs ORDER BY created_at ASC").all().map((row) => row.id),
      ["middle-live", "newest-live"],
    );
  } finally {
    db.close();
  }
});

test("maxDetailBytes counts UTF-8 bytes and keeps the newest row under the byte cap", async (context) => {
  const { pruneRequestLogs } = await import("../dist/db.js");
  const db = await openWithPolicy(context, {
    retentionDays: 3650,
    maxRows: 100,
    maxDetailBytes: 100,
  });
  try {
    addRows(db, [
      { id: "first", created_at: "2026-01-01T00:00:00.000Z", request_detail: "你".repeat(20) },
      { id: "second", created_at: "2026-01-01T00:00:00.000Z", request_detail: "好".repeat(20) },
      { id: "third", created_at: "2026-01-01T00:00:00.000Z", request_detail: "界".repeat(20) },
    ]);
    assert.equal(pruneRequestLogs(db), 2);
    const rows = db.prepare("SELECT id, model, request_detail, response_detail FROM request_logs").all();
    assert.deepEqual(rows.map((row) => row.id), ["third"]);
    const bytes = rows.reduce(
      (sum, row) =>
        sum +
        Buffer.byteLength(row.model ?? "", "utf8") +
        Buffer.byteLength(row.request_detail ?? "", "utf8") +
        Buffer.byteLength(row.response_detail ?? "", "utf8"),
      0,
    );
    assert.ok(bytes <= 100, `stored detail bytes=${String(bytes)}`);
  } finally {
    db.close();
  }
});

test("detail pruning batches the byte scan instead of recomputing SUM after every deleted row", async (context) => {
  const { pruneRequestLogs } = await import("../dist/db.js");
  const db = await openWithPolicy(context, {
    retentionDays: 3650,
    maxRows: 1000,
    maxDetailBytes: 250,
  });
  const rowCount = 40;
  try {
    addRows(
      db,
      Array.from({ length: rowCount }, (_, index) => ({
        id: `same-time-${String(index).padStart(2, "0")}`,
        // Equal timestamps require a stable tie-breaker (rowid is valid for this table).
        created_at: "2026-01-01T00:00:00.000Z",
        request_detail: "x".repeat(100),
      })),
    );

    let byteLengthCalls = 0;
    db.function("length", (value) => {
      byteLengthCalls += 1;
      if (value === null || value === undefined) return null;
      if (typeof value === "string") return Buffer.byteLength(value, "utf8");
      if (ArrayBuffer.isView(value)) return value.byteLength;
      return Buffer.byteLength(String(value), "utf8");
    });

    assert.equal(pruneRequestLogs(db), rowCount - 2);
    assert.ok(byteLengthCalls > 0, "the byte-size SQL path was exercised");
    assert.ok(
      byteLengthCalls <= rowCount * 10,
      `length() calls=${String(byteLengthCalls)} indicate a repeated full-table SUM`,
    );
    assert.deepEqual(
      db.prepare("SELECT id FROM request_logs ORDER BY rowid").all().map((row) => row.id),
      ["same-time-38", "same-time-39"],
    );
  } finally {
    db.close();
  }
});
