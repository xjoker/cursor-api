#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const maxRows = 100_000;
const maxDetailBytes = 268_435_456;
const retentionDays = 7;
const dayMs = 86_400_000;
const detailPayloadBytes = 1_024;
const httpSampleCount = 5;
const tempRoot = mkdtempSync(join(tmpdir(), "cursor-api-sqlite-benchmark-"));
const blockedLog = join(tempRoot, "blocked.log");
const guardUrl = pathToFileURL(join(root, "tests", "fixtures", "no-network.mjs")).href;

const existingNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .split(/\s+/)
  .filter((part) => part !== "" && !part.includes("no-network.mjs"));
process.env.NODE_OPTIONS = [...existingNodeOptions, `--import=${guardUrl}`].join(" ");
process.env.CURSOR_API_NETGUARD_LOG = blockedLog;

const gatewayEnv = {
  NODE_ENV: "production",
  CURSOR_API_KEY: "synthetic-upstream-key",
  CURSOR_API_KEYS: "",
  ADMIN_ACCESS_KEY: "synthetic-admin-key",
  API_KEY_PEPPER: "it-pepper",
  GATEWAY_DEFAULT_HOST: "127.0.0.1",
  GIT_COMMIT: "synthetic",
  SOURCE_COMMIT: "synthetic",
  LOG_RETENTION_DAYS: String(retentionDays),
  LOG_MAX_ROWS: String(maxRows),
  LOG_MAX_DETAIL_BYTES: String(maxDetailBytes),
  LOG_DETAILED: "false",
  LOG_DETAILED_MAX_BYTES: "65536",
  REQUEST_TIMEOUT_MS: "300000",
  ADMIN_REQUEST_TIMEOUT_MS: "10000",
  SHUTDOWN_TIMEOUT_MS: "10000",
  PARK_TIMEOUT_MS: "300000",
  IGNORE_SAMPLING_PARAMS: "false",
  ENFORCE_OUTPUT_LIMITS: "false",
  HISTORY_RESUME: "false",
  ALLOW_MAX_MODE: "true",
  QUOTA_CACHE_READ_WEIGHT: "1",
  QUOTA_RESERVE_RECENT_RUNS: "20",
  SSE_KEEPALIVE_MS: "15000",
  AUTH_FAILURE_LIMIT: "20",
  RATE_LIMIT_PER_KEY: "0",
  MAX_LIVE_SESSIONS: "256",
  CONVERSATION_TTL_DAYS: "30",
  CURSOR_KEY_COOLDOWN_MS: "60000",
  CURSOR_KEY_STRATEGY: "round_robin",
  CORS_ALLOW_ORIGINS: "*",
  TRUSTED_PROXIES: "",
  MODEL_ALIASES: "",
};

let db;
let gateway;
let failure;
let cleanupFailed = false;
let benchmark;
let blockedAttempts = 0;

try {
  await import(guardUrl);
  const { CLIENT_KEY, startFakeGateway } = await import(
    pathToFileURL(join(root, "tests", "fixtures", "gateway-harness.mjs")).href,
  );
  const {
    insertRequestLog,
    listRequestLogFilters,
    listRequestLogs,
    openDb,
    pruneRequestLogs,
    requestCallsByDay,
    requestStats,
  } = await import(pathToFileURL(join(root, "dist", "db.js")).href);

  gateway = await startFakeGateway(gatewayEnv);
  db = openDb(gateway.dataDir, {
    retentionDays,
    maxRows,
    maxDetailBytes,
  });

  const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS version").get().version);
  const seedEpoch = Date.now();
  const bounds = {
    from: new Date(seedEpoch - 6 * dayMs).toISOString(),
    to: new Date(seedEpoch + 1_000).toISOString(),
  };
  seedKeys(db, seedEpoch);

  const tiers = [];
  for (const tier of [
    { name: "summary_1000", rows: 1_000, detailed: false },
    { name: "summary_10000", rows: 10_000, detailed: false },
    { name: "summary_100000", rows: 100_000, detailed: false },
    { name: "detail_100000", rows: 100_000, detailed: true },
  ]) {
    const seeded = seedStage(db, tier, seedEpoch);
    const stored = assertStoredStage(db, tier, seeded.bytes, seedEpoch);
    const operations = measureDbOperations(
      db,
      tier.rows,
      bounds,
      insertRequestLog,
      listRequestLogFilters,
      listRequestLogs,
      pruneRequestLogs,
      requestCallsByDay,
      requestStats,
    );
    const afterWrite = storageMetrics(db);
    assert.ok(afterWrite.rows <= maxRows, `${tier.name} write exceeded max rows`);
    tiers.push({
      name: tier.name,
      rows: stored.rows,
      payload_bytes: stored.bytes,
      operations,
    });

    if (tier.detailed) {
      const http = await measureGateway(gateway.baseUrl, CLIENT_KEY);
      assert.equal(http.request_count, httpSampleCount * 3 + 1, "unexpected HTTP request count");
      assert.equal(http.fake_sdk_generation_requests, httpSampleCount * 2, "unexpected fake SDK request count");
      const afterHttp = storageMetrics(db);
      assert.ok(afterHttp.rows <= maxRows, "HTTP writes exceeded max rows");
      assert.ok(afterHttp.bytes <= maxDetailBytes, "HTTP writes exceeded max detail bytes");
      benchmark = {
        meta: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          sqlite: sqliteVersion,
          detail_payload_bytes: detailPayloadBytes,
          policy: {
            retention_days: retentionDays,
            max_rows: maxRows,
            max_detail_bytes: maxDetailBytes,
          },
          http_requests: http.request_count,
          http_fake_sdk_generation_requests: http.fake_sdk_generation_requests,
          insert_probe: "manual BEGIN/ROLLBACK; includes helper/prune, excludes commit/fsync durability",
          network_guard: { enabled: true },
        },
        tiers,
        detailed_http: {
          ...http,
          storage_after_http: {
            rows: afterHttp.rows,
            payload_bytes: afterHttp.bytes,
          },
        },
      };
    }
  }
} catch (error) {
  failure = {
    kind: "benchmark_failed",
    ...safeError(error),
  };
} finally {
  try {
    db?.close();
  } catch {
    cleanupFailed = true;
  }
  try {
    if (gateway) await gateway.stop();
  } catch {
    cleanupFailed = true;
  }
  blockedAttempts = readBlockedAttemptCount(blockedLog);
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    cleanupFailed = true;
  }
}

if (blockedAttempts > 0) {
  failure = {
    kind: "network_guard_blocked",
    name: "NetworkGuardError",
    message: `${String(blockedAttempts)} outbound attempt(s) recorded`,
  };
}
if (cleanupFailed) {
  failure ??= {
    kind: "cleanup_failed",
    name: "CleanupError",
    message: "temporary benchmark resources could not be fully removed",
  };
}
if (failure) {
  console.log(JSON.stringify({ ok: false, error: failure, blocked_attempts: blockedAttempts }));
  process.exitCode = 1;
} else {
  benchmark.meta.network_guard.blocked_attempts = 0;
  console.log(JSON.stringify({ ok: true, ...benchmark }));
}

function seedKeys(database, nowMs) {
  const now = new Date(nowMs).toISOString();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO api_keys (
       id, name, key_prefix, key_digest, enabled, request_limit, used_requests, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [id, index] of [
      ["it-key", 1],
      ["it-key-2", 2],
      ["it-key-3", 3],
    ]) {
      insert.run(
        id,
        `synthetic-${index}`,
        `cgk_synth${index}`,
        `synthetic-digest-${index}`,
        now,
        now,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedStage(database, tier, seedEpoch) {
  const insertLog = database.prepare(
    `INSERT INTO request_logs (
       id, api_key_id, path, model, stream, http_status, duration_ms,
       input_tokens, output_tokens, total_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens,
       error_code, created_at,
       upstream_ms, gateway_ms, request_detail, response_detail,
       raw_cost_cents, charged_cents, cost_scope, max_mode
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let bytes = 0;
  let firstDetailBytes = null;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM request_logs");
    for (let index = 0; index < tier.rows; index += 1) {
      const model = index === 0 ? "fake-model" : ["fake-model", "fake-reasoner", "synthetic-model"][index % 3];
      const apiKeyId = index === 0 ? "it-key" : ["it-key", "it-key-2", "it-key-3"][index % 3];
      const status = index === 0 ? 200 : [200, 201, 400, 429, 500][index % 5];
      const detail = tier.detailed ? makeDetail(tier.name, index) : null;
      const modelBytes = Buffer.byteLength(model, "utf8");
      const detailBytes = detail === null ? 0 : Buffer.byteLength(detail, "utf8");
      if (firstDetailBytes === null && detail !== null) firstDetailBytes = detailBytes;
      bytes += modelBytes + detailBytes;
      insertLog.run(
        `${tier.name}-${String(index).padStart(6, "0")}`,
        apiKeyId,
        index % 2 === 0 ? "/v1/chat/completions" : "/v1/responses",
        model,
        0,
        status,
        1 + (index % 17),
        10 + (index % 11),
        5 + (index % 7),
        15 + (index % 18),
        index % 4 === 0 ? 2 : null,
        index % 6 === 0 ? 1 : null,
        index % 7 === 0 ? 1 : null,
        null,
        createdAt(seedEpoch, index),
        1,
        0,
        detail,
        null,
        null,
        null,
        null,
        index % 9 === 0 ? 1 : 0,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (tier.detailed) assert.equal(firstDetailBytes, detailPayloadBytes);
  return { bytes };
}

function makeDetail(stage, index) {
  const base = {
    kind: "sqlite-capacity",
    stage,
    index,
    utf8: "合成-容量",
    payload: "",
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  const payload = "x".repeat(detailPayloadBytes - baseBytes);
  const detail = JSON.stringify({ ...base, payload });
  assert.equal(Buffer.byteLength(detail, "utf8"), detailPayloadBytes);
  return detail;
}

function createdAt(seedEpoch, index) {
  return new Date(seedEpoch - (index % 5) * dayMs - (index % 1_000) * 1_000).toISOString();
}

function storageMetrics(database) {
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(
           COALESCE(length(cast(model AS BLOB)), 0)
           + COALESCE(length(cast(request_detail AS BLOB)), 0)
           + COALESCE(length(cast(response_detail AS BLOB)), 0)
         ), 0) AS bytes,
         COALESCE(SUM(CASE WHEN request_detail IS NOT NULL THEN 1 ELSE 0 END), 0) AS detail_count,
         COALESCE(SUM(CASE WHEN response_detail IS NOT NULL THEN 1 ELSE 0 END), 0) AS response_detail_count
       FROM request_logs`,
    )
    .get();
  return {
    rows: Number(row.count),
    bytes: Number(row.bytes),
    detail_count: Number(row.detail_count),
    response_detail_count: Number(row.response_detail_count),
  };
}

function assertStoredStage(database, tier, expectedBytes, seedEpoch) {
  const stored = storageMetrics(database);
  assert.equal(stored.rows, tier.rows, `${tier.name} row count`);
  assert.equal(stored.bytes, expectedBytes, `${tier.name} payload bytes`);
  assert.ok(stored.rows <= maxRows, `${tier.name} exceeds max rows`);
  assert.ok(stored.bytes <= maxDetailBytes, `${tier.name} exceeds max detail bytes`);
  assert.equal(stored.response_detail_count, 0, `${tier.name} response_detail must be NULL`);
  assert.equal(stored.detail_count, tier.detailed ? tier.rows : 0, `${tier.name} detail shape`);
  const cutoff = new Date(seedEpoch - retentionDays * dayMs).toISOString();
  const oldRows = Number(
    database.prepare("SELECT COUNT(*) AS count FROM request_logs WHERE created_at < ?").get(cutoff).count,
  );
  assert.equal(oldRows, 0, `${tier.name} contains an expired timestamp`);
  return stored;
}

function measureDbOperations(
  database,
  rows,
  bounds,
  insertRequestLog,
  listRequestLogFilters,
  listRequestLogs,
  pruneRequestLogs,
  requestCallsByDay,
  requestStats,
) {
  const firstPage = { limit: 50, offset: 0 };
  const deepPage = { limit: 50, offset: Math.max(0, rows - 50) };
  const combination = {
    limit: 50,
    offset: 0,
    model: "fake-model",
    api_key_id: "it-key",
    http_status: 200,
    from: bounds.from,
    to: bounds.to,
  };
  const probe = {
    id: "insert-probe",
    api_key_id: "it-key",
    path: "/v1/chat/completions",
    model: "fake-model",
    stream: 0,
    http_status: 200,
    duration_ms: 1,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    error_code: null,
    created_at: new Date().toISOString(),
    upstream_ms: 1,
    gateway_ms: 0,
    request_detail: null,
    response_detail: null,
    raw_cost_cents: null,
    charged_cents: null,
    cost_scope: null,
    max_mode: 0,
  };
  return {
    request_stats: measureSync(() => requestStats(database)),
    request_calls_by_day: measureSync(() => requestCallsByDay(database, 7)),
    list_request_log_filters: measureSync(() => listRequestLogFilters(database)),
    list_request_logs_first_page: measureSync(() => listRequestLogs(database, firstPage)),
    list_request_logs_deep_page: measureSync(() => listRequestLogs(database, deepPage)),
    list_request_logs_combined_filter: measureSync(() => listRequestLogs(database, combination)),
    prune_request_logs: measureSync(() => pruneRequestLogs(database)),
    insert_request_log: measureSync(() => {
      // Roll back the probe: timing includes helper/prune work, but excludes durable commit/fsync.
      database.exec("BEGIN");
      try {
        insertRequestLog(database, probe);
      } finally {
        database.exec("ROLLBACK");
      }
    }),
  };
}

function measureSync(operation) {
  operation();
  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median_ms: roundMs(sorted[Math.floor(sorted.length / 2)]),
    max_ms: roundMs(sorted[sorted.length - 1]),
  };
}

async function measureGateway(baseUrl, clientKey) {
  const chatIdleSamples = [];
  for (let index = 0; index < httpSampleCount; index += 1) {
    chatIdleSamples.push(
      await timedFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "benchmark" }] }),
      }),
    );
  }

  const chatWithStatsSamples = [];
  const adminStatsWithChatSamples = [];
  for (let index = 0; index < httpSampleCount; index += 1) {
    const [chatMs, statsMs] = await Promise.all([
      timedFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "benchmark" }] }),
      }),
      timedFetch(`${baseUrl}/admin/api/stats`, {
        headers: { authorization: "Bearer synthetic-admin-key" },
      }),
    ]);
    chatWithStatsSamples.push(chatMs);
    adminStatsWithChatSamples.push(statsMs);
  }
  // The health response follows synchronous log insertion/pruning after chat res.end.
  await timedFetch(`${baseUrl}/health`, {});
  return {
    completion_barrier: "GET /health after samples",
    request_count: chatIdleSamples.length + chatWithStatsSamples.length + adminStatsWithChatSamples.length + 1,
    fake_sdk_generation_requests: chatIdleSamples.length + chatWithStatsSamples.length,
    chat_idle: summarize(chatIdleSamples),
    chat_with_stats: summarize(chatWithStatsSamples),
    admin_stats_with_chat: summarize(adminStatsWithChatSamples),
  };
}

async function timedFetch(url, options) {
  const started = performance.now();
  const response = await fetch(url, options);
  await response.arrayBuffer();
  assert.equal(response.status, 200, `benchmark HTTP ${new URL(url).pathname}`);
  return performance.now() - started;
}

function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

function readBlockedAttemptCount(file) {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8").trim();
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function safeError(error) {
  const name = error instanceof Error && error.name ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  for (const [value, replacement] of [
    [root, "<repo>"],
    [tempRoot, "<tmp>"],
    [gateway?.dataDir, "<gateway-data>"],
    ["synthetic-upstream-key", "<synthetic-upstream-key>"],
    ["synthetic-admin-key", "<synthetic-admin-key>"],
    ["synthetic-pepper", "<synthetic-pepper>"],
    ["it-admin-key", "<synthetic-admin-key>"],
    ["it-pepper", "<synthetic-pepper>"],
    ["cgk_integration_test_key", "<synthetic-client-key>"],
  ]) {
    if (value) message = message.split(value).join(replacement);
  }
  return { name, message: message.slice(0, 500) };
}
