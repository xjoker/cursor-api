// SQLite query plans are the performance contract for request statistics and log pruning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { insertApiKey, openDb, pruneRequestLogs, requestStats } from "../dist/db.js";

const POLICY = {
  retentionDays: 3650,
  maxRows: 1000,
  maxDetailBytes: 1_000_000,
};

const KEYS = [
  {
    id: "key-a",
    name: "key-a",
    key_prefix: "cgk_key_a",
    key_digest: "digest-key-a",
  },
  {
    id: "key-b",
    name: "key-b",
    key_prefix: "cgk_key_b",
    key_digest: "digest-key-b",
  },
];

const INSERT_LOG = `
  INSERT INTO request_logs (
    id, api_key_id, path, model, stream, http_status, duration_ms,
    input_tokens, output_tokens, total_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens,
    error_code, created_at, upstream_ms, gateway_ms,
    request_detail, response_detail, raw_cost_cents, charged_cents, cost_scope, max_mode
  ) VALUES (?, ?, '/v1/chat/completions', ?, 0, ?, 1,
    ?, ?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?, NULL, NULL, NULL, 0)
`;

function seedKeys(db) {
  for (const key of KEYS) {
    insertApiKey(db, {
      ...key,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
}

function insertLog(db, row, insert = db.prepare(INSERT_LOG)) {
  insert.run(
    row.id,
    row.api_key_id,
    row.model,
    row.http_status,
    row.input_tokens,
    row.output_tokens,
    row.total_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.reasoning_tokens,
    row.created_at,
    row.request_detail ?? null,
    row.response_detail ?? null,
  );
}

function seedLogs(db, rows) {
  const insert = db.prepare(INSERT_LOG);
  db.exec("BEGIN");
  try {
    for (const row of rows) insertLog(db, row, insert);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function capturePreparedSql(db) {
  const originalPrepare = db.prepare;
  const sqls = [];
  let enabled = true;
  db.prepare = function trackedPrepare(sql, ...args) {
    if (enabled) sqls.push(String(sql));
    return originalPrepare.call(this, sql, ...args);
  };
  return {
    sqls,
    stop() {
      if (!enabled) return;
      enabled = false;
      db.prepare = originalPrepare;
    },
  };
}

function planDetails(db, sql) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row.detail));
}

function assertIndexedPlan(db, sql, label) {
  const details = planDetails(db, sql);
  assert.ok(
    details.some((detail) => /USING (?:COVERING )?INDEX/i.test(detail)),
    `${label} must use an index; plan=${JSON.stringify(details)}`,
  );
}

function tableColumnReads(db, sql) {
  const table = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'request_logs'")
    .get();
  const tableRootPage = Number(table.rootpage);
  const vm = db.prepare(`EXPLAIN ${sql}`).all();
  const tableCursors = new Set(
    vm
      .filter((row) => row.opcode === "OpenRead" && Number(row.p2) === tableRootPage)
      .map((row) => Number(row.p1)),
  );
  return vm.filter((row) => row.opcode === "Column" && tableCursors.has(Number(row.p1)));
}

function assertNoTableColumnReads(db, sql, label) {
  assert.deepEqual(
    tableColumnReads(db, sql),
    [],
    `${label} must read through an index, not request_logs table columns`,
  );
}

function statsRows() {
  return [
    {
      id: "a-1",
      api_key_id: "key-a",
      model: "model-z",
      http_status: 200,
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      cache_read_tokens: 1,
      cache_write_tokens: 2,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "a-2",
      api_key_id: "key-a",
      model: "model-中",
      http_status: 500,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: 7,
      cache_write_tokens: 8,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      id: "b-1",
      api_key_id: "key-b",
      model: "model-z",
      http_status: 200,
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9,
      cache_read_tokens: null,
      cache_write_tokens: 1,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:02.000Z",
    },
    {
      id: "b-2",
      api_key_id: "key-b",
      model: "model-中",
      http_status: 500,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:03.000Z",
    },
    {
      id: "a-private-use",
      api_key_id: "key-a",
      model: "model-\uE000",
      http_status: 201,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:04.000Z",
    },
    {
      id: "b-supplementary",
      api_key_id: "key-b",
      model: "model-\u{10000}",
      http_status: 202,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      created_at: "2026-01-01T00:00:05.000Z",
    },
  ];
}

function oneStatRow(id) {
  return {
    id,
    api_key_id: "key-a",
    model: "model-z",
    http_status: 200,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

test("requestStats reuses grouped aggregates and keeps SQLite result semantics", (context) => {
  const db = openDb(makeTempDir(context, "log-stats-plan-"), POLICY);
  let tracker;
  try {
    seedKeys(db);
    assert.deepEqual(requestStats(db), {
      by_key: [],
      by_model: [],
      by_status: [],
      tokens: {
        retention_days: POLICY.retentionDays,
        max_rows: POLICY.maxRows,
        max_detail_bytes: POLICY.maxDetailBytes,
        totals: {
          request_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          unknown_usage_count: 0,
        },
        by_model: [],
      },
      tokens_by_key: [],
    });

    seedLogs(db, statsRows());
    tracker = capturePreparedSql(db);
    const stats = requestStats(db);
    tracker.stop();

    assert.deepEqual(stats.by_key, [
      { api_key_id: "key-a", count: 3 },
      { api_key_id: "key-b", count: 3 },
    ]);
    assert.deepEqual(stats.by_model, [
      { model: "model-z", count: 2 },
      { model: "model-中", count: 2 },
      { model: "model-\uE000", count: 1 },
      { model: "model-\u{10000}", count: 1 },
    ]);
    assert.deepEqual(stats.by_status, [
      { http_status: 200, count: 2 },
      { http_status: 201, count: 1 },
      { http_status: 202, count: 1 },
      { http_status: 500, count: 2 },
    ]);
    assert.deepEqual(stats.tokens.totals, {
      request_count: 6,
      input_tokens: 14,
      output_tokens: 7,
      total_tokens: 21,
      cache_read_tokens: 11,
      cache_write_tokens: 15,
      unknown_usage_count: 4,
    });
    assert.deepEqual(stats.tokens.by_model, [
      { model: "model-z", request_count: 2, input_tokens: 14, output_tokens: 7, total_tokens: 21, cache_read_tokens: 1, cache_write_tokens: 3, unknown_usage_count: 0 },
      { model: "model-中", request_count: 2, input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 10, cache_write_tokens: 12, unknown_usage_count: 2 },
      { model: "model-\uE000", request_count: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, unknown_usage_count: 1 },
      { model: "model-\u{10000}", request_count: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, unknown_usage_count: 1 },
    ]);
    assert.deepEqual(stats.tokens_by_key.map(({ api_key_id, request_count }) => ({ api_key_id, request_count })), [
      { api_key_id: "key-a", request_count: 3 },
      { api_key_id: "key-b", request_count: 3 },
    ]);

    const groupedByKey = tracker.sqls.filter((sql) => /\bGROUP BY\s+api_key_id\b/i.test(sql));
    const groupedByModel = tracker.sqls.filter((sql) => /\bGROUP BY\s+model\b/i.test(sql));
    assert.equal(groupedByKey.length, 1, `api_key_id grouping was repeated: ${JSON.stringify(groupedByKey)}`);
    assert.equal(groupedByModel.length, 1, `model grouping was repeated: ${JSON.stringify(groupedByModel)}`);
    assert.equal(
      tracker.sqls.some((sql) => /request_detail|response_detail/i.test(sql)),
      false,
      "requestStats must not read request or response detail columns",
    );

    const statsSqls = tracker.sqls.filter(
      (sql) => /^\s*SELECT\b/i.test(sql) && /\bFROM\s+request_logs\b/i.test(sql),
    );
    assert.ok(statsSqls.length > 0, "requestStats must execute request_logs aggregate SQL");
    for (const [index, sql] of statsSqls.entries()) {
      assertIndexedPlan(db, sql, `requestStats aggregate ${String(index)}`);
      assertNoTableColumnReads(db, sql, `requestStats aggregate ${String(index)}`);
    }
  } finally {
    tracker?.stop();
    db.close();
  }
});

test("normal log pruning reads the UTF-8 byte sum without table columns", (context) => {
  const db = openDb(makeTempDir(context, "log-prune-plan-"), POLICY);
  let tracker;
  try {
    seedKeys(db);
    seedLogs(
      db,
      Array.from({ length: 128 }, (_, index) => ({
        id: `detail-${String(index).padStart(3, "0")}`,
        api_key_id: index % 2 === 0 ? "key-a" : "key-b",
        model: "model-z",
        http_status: 200,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        request_detail: `你-${"x".repeat(96)}`,
        response_detail: `好-${"y".repeat(96)}`,
      })),
    );

    tracker = capturePreparedSql(db);
    assert.equal(pruneRequestLogs(db), 0);
    tracker.stop();

    const byteSumSql = tracker.sqls.find(
      (sql) => /\bSUM\s*\(/i.test(sql) && /request_detail/i.test(sql) && /response_detail/i.test(sql),
    );
    assert.ok(byteSumSql, `pruneRequestLogs did not execute the detail-byte sum: ${JSON.stringify(tracker.sqls)}`);
    assertNoTableColumnReads(db, byteSumSql, "normal prune detail-byte sum");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM request_logs").get().count, 128);
  } finally {
    tracker?.stop();
    db.close();
  }
});

test("requestStats sees committed direct writes across connections and after reopen", (context) => {
  const dataDir = makeTempDir(context, "log-stats-freshness-");
  let primary = openDb(dataDir, POLICY);
  let peer;
  let reopened;
  try {
    seedKeys(primary);
    seedLogs(primary, [oneStatRow("committed")]);

    peer = openDb(dataDir, POLICY);
    assert.equal(requestStats(peer).tokens.totals.request_count, 1);

    seedLogs(primary, [oneStatRow("committed-after-peer-read")]);
    assert.equal(requestStats(peer).tokens.totals.request_count, 2);

    primary.exec("BEGIN");
    try {
      insertLog(primary, oneStatRow("rolled-back"));
      primary.exec("ROLLBACK");
    } catch (error) {
      primary.exec("ROLLBACK");
      throw error;
    }
    assert.equal(requestStats(peer).tokens.totals.request_count, 2);

    peer.close();
    peer = undefined;
    primary.close();
    primary = undefined;
    reopened = openDb(dataDir, POLICY);
    assert.equal(requestStats(reopened).tokens.totals.request_count, 2);
  } finally {
    reopened?.close();
    peer?.close();
    primary?.close();
  }
});
