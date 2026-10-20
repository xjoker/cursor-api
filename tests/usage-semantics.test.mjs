// OpenAI usage semantics: prompt_tokens includes cache reads/writes; totals are consistent.
// Per-key token quotas can weight cache-read tokens.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toChatUsage } from "../dist/cursor.js";
import { encodeAnthropicUsage } from "../dist/anthropic.js";
import { loadConfig } from "../dist/config.js";
import { getApiKeyById, getKeyUsageRow, insertApiKey, openDb } from "../dist/db.js";
import { admitKeyRequest, configureQuota, runScopedUsageSource } from "../dist/key-policy.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

test("SDK TokenUsage maps to OpenAI usage with consistent totals", () => {
  // Live shape from the gateway ledger: 14551 uncached input, 7106 cache read, 159 output.
  const usage = toChatUsage({ inputTokens: 14551, outputTokens: 159, cacheReadTokens: 7106, cacheWriteTokens: 40, totalTokens: 21856, reasoningTokens: 30 });
  assert.equal(usage.prompt_tokens, 14551 + 7106 + 40);
  assert.equal(usage.completion_tokens, 159);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  assert.equal(usage.total_tokens, 21856, "equals the SDK totalTokens");
  assert.equal(usage.cache_read_tokens, 7106);
  assert.equal(usage.reasoning_tokens, 30);
  assert.equal("reasoning_tokens" in toChatUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }), false);
  assert.deepEqual(encodeAnthropicUsage(usage), {
    input_tokens: 14551,
    output_tokens: 159,
    cache_creation_input_tokens: 40,
    cache_read_input_tokens: 7106,
  });
});

test("all three routes report consistent usage", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway();
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  const post = (path, body, extra = {}) =>
    fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    let res = await post("/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: "hi" }] });
    let usage = (await res.json()).usage;
    assert.deepEqual(
      [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.prompt_tokens_details.cached_tokens],
      [14, 2, 16, 3],
    );
    res = await post("/v1/chat/completions", { model: "fake-model", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] });
    usage = parseSse(await res.text()).map((f) => f.data?.usage).find(Boolean);
    assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
    res = await post("/v1/responses", { model: "fake-model", input: "hi" });
    usage = (await res.json()).usage;
    assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.input_tokens_details.cached_tokens], [14, 2, 16, 3]);
    res = await post("/v1/messages", { model: "fake-model", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2023-06-01" });
    usage = (await res.json()).usage;
    assert.deepEqual([usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens], [11, 3, 2]);
  } finally {
    await gateway.stop();
  }
});

test("cache-read weight: default 1.0 (unchanged), gateway setting, per-key override", () => {
  const result = { usage: { prompt_tokens: 110, completion_tokens: 10, total_tokens: 120, cache_read_tokens: 100 }, usageKnown: true, usageScope: "run" };
  assert.equal(runScopedUsageSource(result, { cacheReadWeight: 1 }), 120);
  assert.equal(runScopedUsageSource(result, { cacheReadWeight: 0.1 }), 30);
  assert.equal(runScopedUsageSource(result, { cacheReadWeight: 0 }), 20);
  assert.equal(runScopedUsageSource({ ...result, usage: { ...result.usage, cache_read_tokens: 3 } }, { cacheReadWeight: 0.5 }), 119, "rounded up");

  const db = openDb(mkdtempSync(join(tmpdir(), "cache-weight-")));
  const now = new Date().toISOString();
  const seed = (id, extra) => {
    insertApiKey(db, { id, name: id, key_prefix: id, key_digest: `d-${id}`, created_at: now, updated_at: now, quota_tokens: 10_000, ...extra });
    return getApiKeyById(db, id);
  };
  const charge = (key) => {
    const ticket = admitKeyRequest(db, key);
    ticket.markStarted();
    ticket.finish(result);
    return getKeyUsageRow(db, key.id, "total").tokens;
  };
  try {
    assert.equal(charge(seed("inherit-default")), 120);
    configureQuota({ cacheReadWeight: 0.1 });
    assert.equal(charge(seed("inherit-global")), 30);
    const own = seed("own", { quota_cache_read_weight: 0.5 });
    assert.equal(own.quota_cache_read_weight, 0.5);
    assert.equal(charge(own), 70);
  } finally {
    configureQuota({ cacheReadWeight: 1 });
    db.close();
  }
});

test("quota_cache_read_weight config parses from env and TOML, default 1", () => {
  const root = mkdtempSync(join(tmpdir(), "cache-weight-cfg-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  const toml = join(root, "data", "config", "gateway.toml");
  const base = ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"'];
  writeFileSync(toml, [...base, ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).quotaCacheReadWeight, 1);
  assert.equal(loadConfig({ DATA_DIR: "data", QUOTA_CACHE_READ_WEIGHT: "0.25" }, root).quotaCacheReadWeight, 0.25);
  for (const bad of ["1.5", "-1", "abc"]) {
    assert.throws(() => loadConfig({ DATA_DIR: "data", QUOTA_CACHE_READ_WEIGHT: bad }, root), /quota_cache_read_weight|QUOTA_CACHE_READ_WEIGHT/);
  }
  writeFileSync(toml, [...base, "quota_cache_read_weight = 0.1", ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).quotaCacheReadWeight, 0.1);
});

test("admin PATCH validates quota_cache_read_weight", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  const admin = (body) =>
    fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, {
      method: "PATCH",
      headers: { authorization: "Bearer it-admin-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await admin({ quota_cache_read_weight: 2 })).status, 400);
    assert.equal((await admin({ quota_cache_read_weight: "0.1" })).status, 400);
    let res = await admin({ quota_cache_read_weight: 0.1 });
    assert.equal((await res.json()).quota_cache_read_weight, 0.1);
    res = await admin({ quota_cache_read_weight: null });
    assert.equal((await res.json()).quota_cache_read_weight, null);
  } finally {
    await gateway.stop();
  }
});
