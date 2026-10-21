import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digestClientKey } from "../dist/auth.js";
import {
  addKeyTokens,
  getApiKeyByDigest,
  insertApiKey,
  insertRequestLog,
  insertSystemLog,
  openDb,
  reserveKeyRequest,
  updateApiKeyPolicy,
  upsertConversation,
} from "../dist/db.js";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const PEPPER = "backup-test-pepper";
const CLIENT_KEY = "cgk_backup_restore_key";
const TIMESTAMP = new Date().toISOString();
const LOG_POLICY = { retentionDays: 30, maxRows: 1_000, maxDetailBytes: 1_048_576 };

function coreRows(db) {
  return {
    apiKeys: db
      .prepare(
        `SELECT id, key_digest, allowed_models, allow_max_mode, quota_requests, quota_tokens,
                quota_period, quota_tz, max_concurrent, quota_cache_read_weight
           FROM api_keys
          ORDER BY id`,
      )
      .all(),
    usage: db
      .prepare(
        `SELECT api_key_id, period_start, requests, tokens, updated_at
           FROM api_key_usage
          ORDER BY api_key_id, period_start`,
      )
      .all(),
    requestLogs: db
      .prepare(
        `SELECT id, api_key_id, path, model, http_status, input_tokens, output_tokens,
                total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
                raw_cost_cents, charged_cents, cost_scope, max_mode
           FROM request_logs
          ORDER BY id`,
      )
      .all(),
    conversations: db
      .prepare(
        `SELECT api_key_id, conversation_id, agent_id, cursor_key_id, updated_at
           FROM conversations
          ORDER BY api_key_id, conversation_id`,
      )
      .all(),
    systemLogs: db
      .prepare("SELECT id, level, message, fields, created_at FROM system_logs ORDER BY id")
      .all(),
  };
}

test("VACUUM INTO preserves a live WAL database for independent restore", { timeout: 20_000 }, (context) => {
  const root = makeTempDir(context, "cursor-api-backup-restore-");
  const sourceDir = join(root, "source");
  const restoredDir = join(root, "restored");
  const backupPath = join(root, "cursor-api-backup.sqlite");
  mkdirSync(sourceDir);

  let source;
  let restored;
  try {
    source = openDb(sourceDir, LOG_POLICY);
    source.exec("PRAGMA wal_autocheckpoint = 0");
    assert.equal(source.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(Number(source.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint), 0);

    insertApiKey(source, {
      id: "backup-key",
      name: "backup fixture",
      key_prefix: CLIENT_KEY.slice(0, 12),
      key_digest: digestClientKey(PEPPER, CLIENT_KEY),
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      allowed_models: ["fake-model", "fake-reasoner"],
      allow_max_mode: false,
      quota_requests: 17,
      quota_tokens: 3_456,
      quota_period: "daily",
      quota_tz: "UTC",
      max_concurrent: 3,
      quota_cache_read_weight: 0.25,
    });
    const updated = updateApiKeyPolicy(source, "backup-key", {
      allowed_models: ["fake-model"],
      allow_max_mode: true,
      quota_requests: 23,
      quota_tokens: 4_567,
      quota_period: "monthly",
      quota_tz: "Asia/Singapore",
      max_concurrent: 2,
      quota_cache_read_weight: 0.5,
    });
    assert.equal(updated?.id, "backup-key");

    const reserved = reserveKeyRequest(source, "backup-key", "2026-10", {
      quotaRequests: 23,
      quotaTokens: 4_567,
      reserveTokens: 123,
    });
    assert.equal(reserved.ok, true);
    addKeyTokens(source, "backup-key", "2026-10", 321);

    insertRequestLog(source, {
      id: "request-backup",
      api_key_id: "backup-key",
      path: "/v1/chat/completions",
      model: "fake-model",
      stream: 0,
      http_status: 200,
      duration_ms: 42,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      error_code: null,
      created_at: TIMESTAMP,
      upstream_ms: 12,
      gateway_ms: 30,
      request_detail: null,
      response_detail: null,
      raw_cost_cents: 12.5,
      charged_cents: 8.25,
      cost_scope: "agent_total",
      max_mode: 1,
    });
    upsertConversation(source, "backup-key", "conversation-backup", "agent-backup", "cursor-key-a");
    insertSystemLog(source, {
      id: "system-backup",
      level: "info",
      message: "backup fixture",
      fields: { charged_cents: 8.25, phase: "before-snapshot" },
      created_at: TIMESTAMP,
    });

    const expected = coreRows(source);
    const walPath = join(sourceDir, "cursor-api.sqlite-wal");
    assert.ok(existsSync(walPath) && statSync(walPath).size > 0, "source has uncheckpointed WAL data");
    assert.equal(existsSync(backupPath), false, "VACUUM INTO target starts empty");
    source.prepare("VACUUM INTO ?").run(backupPath);
    assert.ok(existsSync(backupPath) && statSync(backupPath).size > 0, "online snapshot was created");

    insertSystemLog(source, {
      id: "source-only-after-snapshot",
      level: "info",
      message: "source changed after snapshot",
      created_at: TIMESTAMP,
    });
    assert.ok(source.prepare("SELECT 1 FROM system_logs WHERE id = ?").get("source-only-after-snapshot"));

    mkdirSync(restoredDir);
    copyFileSync(backupPath, join(restoredDir, "cursor-api.sqlite"));
    restored = openDb(restoredDir, LOG_POLICY);
    assert.equal(Number(restored.prepare("PRAGMA user_version").get().user_version), 12);
    assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(coreRows(restored), expected);
    assert.equal(
      restored.prepare("SELECT 1 FROM system_logs WHERE id = ?").get("source-only-after-snapshot"),
      undefined,
      "snapshot is independent from later source writes",
    );

    assert.equal(getApiKeyByDigest(restored, digestClientKey(PEPPER, CLIENT_KEY))?.id, "backup-key");
    assert.equal(getApiKeyByDigest(restored, digestClientKey("wrong-pepper", CLIENT_KEY)), undefined);
  } finally {
    try {
      restored?.close();
    } finally {
      source?.close();
    }
  }
});
