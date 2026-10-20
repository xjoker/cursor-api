import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { rateLimitError } from "../dist/errors.js";
import { CursorKeyPool } from "../dist/keypool.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

test("cursor_key_strategy defaults to round_robin and accepts least_active", (context) => {
  const root = makeTempDir(context, "cursor-api-strategy-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"', ""].join("\n"),
  );
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).cursorKeyStrategy, "round_robin");
  assert.equal(loadConfig({ DATA_DIR: "data", CURSOR_KEY_STRATEGY: "least_active" }, root).cursorKeyStrategy, "least_active");
  assert.equal(loadConfig({ DATA_DIR: "data", CURSOR_KEY_STRATEGY: "least-active" }, root).cursorKeyStrategy, "least_active");
  assert.throws(() => loadConfig({ DATA_DIR: "data", CURSOR_KEY_STRATEGY: "random" }, root), /CURSOR_KEY_STRATEGY/);
});

test("least_active picks the key with fewest in-flight requests, ties rotate", () => {
  const pool = new CursorKeyPool(["a", "b", "c"], { cooldownMs: 1000, strategy: "least_active" });
  assert.equal(pool.strategy, "least_active");
  const releaseA = pool.acquire("a");
  const releaseA2 = pool.acquire("a");
  const releaseB = pool.acquire("b");
  assert.equal(pool.pick(), "c");
  const releaseC = pool.acquire("c");
  assert.equal(pool.pick(), "b");
  releaseA();
  releaseA2();
  releaseA2(); // idempotent
  assert.equal(pool.pick(), "a");
  releaseB();
  releaseC();
  assert.deepEqual([pool.pick(), pool.pick(), pool.pick()], ["b", "c", "a"]);
  assert.deepEqual(pool.snapshot().map((key) => key.active_requests), [0, 0, 0]);

  pool.reportFailure("b", rateLimitError("x"));
  const hold = pool.acquire("a");
  assert.equal(pool.pick(), "c"); // b cooling, a busy
  hold();
});

test("round_robin ignores load; run() tracks in-flight requests and successes", async () => {
  const pool = new CursorKeyPool(["a", "b"], { cooldownMs: 1000 });
  const release = pool.acquire("a");
  assert.deepEqual([pool.pick(), pool.pick(), pool.pick()], ["a", "b", "a"]);
  release();

  let seen;
  await pool.run(async (key) => {
    seen = pool.snapshot().find((entry) => entry.active_requests === 1)?.id;
    return key;
  });
  assert.ok(seen);
  const after = pool.snapshot();
  assert.deepEqual(after.map((key) => key.active_requests), [0, 0]);
  assert.equal(after.reduce((sum, key) => sum + key.successes, 0), 1);
  assert.ok(after.some((key) => key.last_used_at !== null));
});

test("gateway spreads concurrent requests by in-flight load and reports it", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({
    CURSOR_API_KEY: "good-key-1",
    CURSOR_API_KEYS: "good-key-2",
    CURSOR_KEY_STRATEGY: "least_active",
    FAKE_SDK_DELAY_MS: "500",
  });
  const admin = async () =>
    (await fetch(`${gateway.baseUrl}/admin/api/cursor-keys`, { headers: { authorization: "Bearer it-admin-key" } })).json();
  try {
    const inflight = ["one", "two"].map((content) =>
      fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content }] }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const during = await admin();
    assert.equal(during.strategy, "least_active");
    assert.deepEqual(during.keys.map((key) => key.active_requests), [1, 1]);
    for (const res of await Promise.all(inflight)) assert.equal(res.status, 200);
    const after = await admin();
    assert.deepEqual(after.keys.map((key) => key.active_requests), [0, 0]);
    assert.ok(after.keys.every((key) => key.successes >= 1));
  } finally {
    await gateway.stop();
  }
});
