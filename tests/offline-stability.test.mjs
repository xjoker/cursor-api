import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const ADMIN_HEADERS = { authorization: "Bearer it-admin-key" };
const CLIENT_HEADERS = {
  authorization: `Bearer ${CLIENT_KEY}`,
  "content-type": "application/json",
};

function ledgerEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function waitForLedger(path, check, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = ledgerEvents(path);
    if (check(events)) return events;
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function post(gateway, path, body, options = {}) {
  return fetch(`${gateway.baseUrl}${path}`, {
    method: "POST",
    headers: CLIENT_HEADERS,
    body: JSON.stringify(body),
    ...options,
  });
}

async function adminJson(gateway, path) {
  const response = await fetch(`${gateway.baseUrl}${path}`, { headers: ADMIN_HEADERS });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text);
}

async function stableRequest(gateway, path, body) {
  const response = await post(gateway, path, body);
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  assert.doesNotThrow(() => JSON.parse(text), path);
}

async function timeoutRequest(gateway, path, body) {
  const response = await post(gateway, path, body);
  const payload = await response.json();
  assert.equal(response.status, 504, `${path}: ${JSON.stringify(payload)}`);
  assert.equal(payload.error?.code, "request_timeout", path);
}

async function cancelRequest(gateway, ledgerPath, path, body) {
  const controller = new AbortController();
  const before = ledgerEvents(ledgerPath).length;
  const pending = post(gateway, path, body, { signal: controller.signal });
  await waitForLedger(
    ledgerPath,
    (events) => events.slice(before).some((event) => event.event === "send_started"),
    "client-cancel request accepted by fake SDK",
  );
  controller.abort();
  await pending.catch(() => undefined);
}

async function settledBatch(gateway, ledgerPath, expectedDisposals) {
  await waitForLedger(
    ledgerPath,
    (events) => events.filter((event) => event.event === "dispose").length >= expectedDisposals,
    `batch ${String(expectedDisposals / 4)} SDK operations settled`,
  );

  const overview = await adminJson(gateway, "/admin/api/overview");
  assert.equal(overview.sessions.live, 0, "no live sessions remain");
  assert.equal(overview.sessions.running, 0, "no running sessions remain");
  assert.equal(overview.runtime.pending_session_operations, 0, "SDK cleanup has settled");
  assert.ok(
    overview.runtime.response_cache.payload_bytes <= 32 * 1024 * 1024,
    "response cache payload stays within 32 MiB",
  );

  const usage = (await adminJson(gateway, "/admin/api/keys")).keys.find((key) => key.id === "it-key")?.usage_current;
  assert.ok(usage, "seeded key usage is present");
  assert.equal(usage.in_flight, 0, "key in-flight count is released");

  const memory = overview.runtime.memory;
  return {
    rss_bytes: memory.rss_bytes,
    heap_used_bytes: memory.heap_used_bytes,
    heap_total_bytes: memory.heap_total_bytes,
  };
}

test("three offline request batches settle sessions and SDK operations", { timeout: 25_000 }, async (context) => {
  const ledgerPath = join(makeTempDir(context, "cursor-api-offline-stability-"), "sdk-ledger.jsonl");
  const gateway = await startFakeGateway({ REQUEST_TIMEOUT_MS: "500", FAKE_SDK_LEDGER: ledgerPath });
  const snapshots = [];
  try {
    for (let batch = 1; batch <= 3; batch += 1) {
      const disposalsBefore = ledgerEvents(ledgerPath).filter((event) => event.event === "dispose").length;
      await stableRequest(gateway, "/v1/chat/completions", {
        model: "fake-model",
        messages: [{ role: "user", content: `SAY<<stable-chat-${String(batch)}>>` }],
      });
      await stableRequest(gateway, "/v1/responses", {
        model: "fake-model",
        input: `SAY<<stable-response-${String(batch)}>>`,
      });
      await timeoutRequest(gateway, "/v1/chat/completions", {
        model: "fake-model",
        messages: [{ role: "user", content: "SLOW_STREAM" }],
      });
      await cancelRequest(gateway, ledgerPath, "/v1/responses", {
        model: "fake-model",
        input: "SLOW_STREAM",
      });

      snapshots.push({ batch, ...(await settledBatch(gateway, ledgerPath, disposalsBefore + 4)) });
    }
    context.diagnostic(JSON.stringify({ offline_memory_snapshots: snapshots }));
    assert.equal(snapshots.length, 3);
    for (const snapshot of snapshots) {
      for (const field of ["rss_bytes", "heap_used_bytes", "heap_total_bytes"]) {
        assert.ok(Object.hasOwn(snapshot, field), `${snapshot.batch}:${field}`);
      }
    }
  } finally {
    await gateway.stop();
  }
});
