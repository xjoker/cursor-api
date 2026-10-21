import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const ADMIN_HEADERS = { authorization: "Bearer it-admin-key" };
const CLIENT_HEADERS = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };

async function overview(gateway) {
  const response = await fetch(`${gateway.baseUrl}/admin/api/overview`, { headers: ADMIN_HEADERS });
  assert.equal(response.status, 200);
  return response.json();
}

test("admin overview exposes bounded local runtime metrics and default timeout settings", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const unauthenticated = await fetch(`${gateway.baseUrl}/admin/api/overview`);
    assert.equal(unauthenticated.status, 401);

    const payload = await overview(gateway);
    assert.equal(payload.settings.request_timeout_ms, 300_000);
    assert.equal(payload.settings.shutdown_timeout_ms, 10_000);

    assert.deepEqual(Object.keys(payload.runtime).sort(), [
      "memory",
      "pending_session_operations",
      "response_cache",
      "uptime_seconds",
    ]);
    assert.ok(Number.isInteger(payload.runtime.uptime_seconds));
    assert.ok(payload.runtime.uptime_seconds >= 0);
    assert.ok(Number.isInteger(payload.runtime.pending_session_operations));
    assert.ok(payload.runtime.pending_session_operations >= 0);
    for (const field of ["rss_bytes", "heap_used_bytes", "heap_total_bytes", "external_bytes", "array_buffers_bytes"]) {
      assert.ok(Number.isInteger(payload.runtime.memory[field]), field);
      assert.ok(payload.runtime.memory[field] >= 0, field);
    }
    assert.deepEqual(Object.keys(payload.runtime.response_cache).sort(), [
      "entries",
      "max_entries",
      "max_entries_per_key",
      "max_payload_bytes",
      "max_payload_bytes_per_key",
      "payload_bytes",
      "ttl_ms",
    ]);
    assert.equal(payload.runtime.response_cache.entries, 0);
    assert.equal(payload.runtime.response_cache.payload_bytes, 0);
    assert.equal(payload.runtime.response_cache.max_entries, 1000);
    assert.equal(payload.runtime.response_cache.max_entries_per_key, 100);
    assert.equal(payload.runtime.response_cache.max_payload_bytes, 32 * 1024 * 1024);
    assert.equal(payload.runtime.response_cache.max_payload_bytes_per_key, 8 * 1024 * 1024);
    assert.equal(payload.runtime.response_cache.ttl_ms, 60 * 60 * 1000);

    const serialized = JSON.stringify(payload);
    for (const secret of ["good-key", "it-admin-key", "it-pepper", CLIENT_KEY, gateway.dataDir, `${gateway.dataDir}/workspace`]) {
      assert.equal(serialized.includes(secret), false, "overview contains a credential or private path");
    }
  } finally {
    await gateway.stop();
  }
});

test("admin overview reports response cache counts and bytes without exposing entries", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    const response = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "fake-model", input: "cache this response" }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const created = await response.json();
    const payload = await overview(gateway);
    const cache = payload.runtime.response_cache;
    assert.equal(cache.entries, 1);
    assert.equal(cache.payload_bytes, Buffer.byteLength(JSON.stringify(created), "utf8"));
    assert.equal(Object.hasOwn(cache, "keys"), false);
    assert.equal(Object.hasOwn(cache, "bodies"), false);
    assert.equal(JSON.stringify(cache).includes(created.id), false);
  } finally {
    await gateway.stop();
  }
});

test("a slow upstream model check still returns local overview state", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ FAKE_SDK_PRECHECK_DELAY_MS: "4000" });
  try {
    const started = Date.now();
    const payload = await overview(gateway);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `overview waited ${String(elapsed)}ms for upstream`);
    assert.equal(payload.upstream, "unavailable");
    assert.equal(payload.upstream_error_code, "upstream_timeout");
    assert.ok(payload.runtime);
    assert.ok(payload.settings);
  } finally {
    await gateway.stop();
  }
});

test("concurrent timed-out overviews share one unresolved upstream check", { timeout: 20_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-admin-observability-");
  const ledgerPath = join(ledgerDir, "sdk-ledger.jsonl");
  const gateway = await startFakeGateway({ FAKE_SDK_PRECHECK_DELAY_MS: "4000", FAKE_SDK_LEDGER: ledgerPath });
  try {
    const responses = await Promise.all([
      fetch(`${gateway.baseUrl}/admin/api/overview`, { headers: ADMIN_HEADERS }),
      fetch(`${gateway.baseUrl}/admin/api/overview`, { headers: ADMIN_HEADERS }),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.upstream, "unavailable");
      assert.equal(payload.upstream_error_code, "upstream_timeout");
    }
    const followupStarted = Date.now();
    const followup = await overview(gateway);
    assert.ok(Date.now() - followupStarted < 1000, "follow-up overview waited for the unresolved probe");
    assert.equal(followup.upstream, "unavailable");
    assert.equal(followup.upstream_error_code, "upstream_timeout");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const starts = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "preflight_started");
    assert.equal(starts.length, 1);
  } finally {
    await gateway.stop();
  }
});
