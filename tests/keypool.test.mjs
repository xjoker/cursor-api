import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { cancelledError, modelNotFound, rateLimitError, upstreamAuthError, upstreamError } from "../dist/errors.js";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  classifyKeyFailure,
  CursorKeyPool,
  fingerprintKey,
} from "../dist/keypool.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test("config merges cursor_api_key with comma-separated cursor_api_keys", (context) => {
  const root = makeTempDir(context, "cursor-api-keys-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "k1"',
      'cursor_api_keys = "k2, k1 ,,k3"',
      "cursor_key_cooldown_ms = 5000",
      'admin_access_key = "a"',
      'api_key_pepper = "p"',
      "",
    ].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.deepEqual(cfg.cursorApiKeys, ["k1", "k2", "k3"]);
  assert.equal(cfg.cursorApiKey, "k1");
  assert.equal(cfg.cursorKeyCooldownMs, 5000);

  const envOnly = loadConfig(
    { DATA_DIR: "data", CURSOR_API_KEY: "", CURSOR_API_KEYS: "e1,e2", CURSOR_KEY_COOLDOWN_MS: "2000" },
    root,
  );
  assert.deepEqual(envOnly.cursorApiKeys, ["k1", "e1", "e2"]);
  assert.equal(envOnly.cursorKeyCooldownMs, 2000);

  const defaults = loadConfig({ DATA_DIR: "data", CURSOR_KEY_COOLDOWN_MS: "" }, root);
  assert.equal(defaults.cursorKeyCooldownMs, 5000);

  const emptyRoot = makeTempDir(context, "cursor-api-keys-empty-");
  mkdirSync(join(emptyRoot, "data", "config"), { recursive: true });
  writeFileSync(
    join(emptyRoot, "data", "config", "gateway.toml"),
    ['cursor_api_keys = "only"', 'admin_access_key = "a"', 'api_key_pepper = "p"', ""].join("\n"),
  );
  assert.deepEqual(loadConfig({ DATA_DIR: "data" }, emptyRoot).cursorApiKeys, ["only"]);
  assert.throws(
    () => loadConfig({ DATA_DIR: "data", CURSOR_KEY_COOLDOWN_MS: "5" }, emptyRoot),
    /cursor_key_cooldown_ms|CURSOR_KEY_COOLDOWN_MS/,
  );
});

test("key pool rotates healthy keys and skips cooling ones", () => {
  const time = clock();
  const pool = new CursorKeyPool(["a", "b", "c", "a", " "], { cooldownMs: 1000, now: time.now });
  assert.equal(pool.size, 3);
  assert.equal(pool.primary, "a");
  assert.deepEqual([pool.pick(), pool.pick(), pool.pick(), pool.pick()], ["a", "b", "c", "a"]);

  assert.equal(pool.reportFailure("b", rateLimitError("slow")), true);
  assert.deepEqual([pool.pick(), pool.pick(), pool.pick()], ["c", "a", "c"]);
  time.advance(1001);
  assert.ok(["a", "b", "c"].includes(pool.pick()));
  assert.equal(pool.snapshot()[1].state, "healthy");
});

test("key pool backs off repeated failures, uses long auth cooldown, and recovers on success", () => {
  const time = clock();
  const pool = new CursorKeyPool(["a", "b"], { cooldownMs: 1000, now: time.now });
  pool.reportFailure("a", rateLimitError("x"));
  pool.reportFailure("a", rateLimitError("x"));
  pool.reportFailure("a", rateLimitError("x"));
  let status = pool.snapshot()[0];
  assert.equal(status.state, "cooling_down");
  assert.equal(status.consecutive_failures, 3);
  assert.equal(Date.parse(status.cooldown_until), time.now() + 4000);

  pool.reportFailure("b", upstreamAuthError());
  status = pool.snapshot()[1];
  assert.equal(status.last_failure, "auth");
  assert.equal(Date.parse(status.cooldown_until), time.now() + AUTH_FAILURE_COOLDOWN_MS);

  // Everything cooling: still hand out the key that recovers first.
  assert.equal(pool.pick(), "a");
  assert.equal(pool.pick(new Set(["a"])), "b");
  assert.equal(pool.pick(new Set(["a", "b"])), undefined);

  pool.reportSuccess("a");
  status = pool.snapshot()[0];
  assert.equal(status.state, "healthy");
  assert.equal(status.consecutive_failures, 0);
  assert.equal(status.failures, 3);
  assert.equal(status.requests, 4);

  assert.equal(pool.reportFailure("a", upstreamError()), false);
  assert.equal(pool.snapshot()[0].state, "healthy");
});

test("key pool run fails over only on key-specific errors and honors canRetry", async () => {
  const pool = new CursorKeyPool(["a", "b", "c"], { cooldownMs: 1000 });
  const seen = [];
  const value = await pool.run(async (key) => {
    seen.push(key);
    if (key === "a") throw upstreamAuthError();
    if (key === "b") throw rateLimitError("slow");
    return `ok:${key}`;
  });
  assert.equal(value, "ok:c");
  assert.deepEqual(seen, ["a", "b", "c"]);

  const fresh = new CursorKeyPool(["a", "b"], { cooldownMs: 1000 });
  const generic = [];
  await assert.rejects(
    fresh.run(async (key) => {
      generic.push(key);
      throw upstreamError();
    }),
    (error) => error.code === "upstream_error",
  );
  assert.equal(generic.length, 1);

  const noRetry = [];
  await assert.rejects(
    new CursorKeyPool(["a", "b"], { cooldownMs: 1000 }).run(
      async (key) => {
        noRetry.push(key);
        throw rateLimitError("late");
      },
      () => false,
    ),
    (error) => error.code === "rate_limit_error",
  );
  assert.equal(noRetry.length, 1);

  const all = [];
  await assert.rejects(
    new CursorKeyPool(["a", "b"], { cooldownMs: 1000 }).run(async (key) => {
      all.push(key);
      throw upstreamAuthError();
    }),
    (error) => error.code === "upstream_authentication_error",
  );
  assert.deepEqual(all, ["a", "b"]);
});

test("model mismatch tries another healthy key without cooling it down", async () => {
  const pool = new CursorKeyPool(["a", "b"], { cooldownMs: 1000 });
  const seen = [];
  const value = await pool.run(async (key) => {
    seen.push(key);
    if (key === "a") throw modelNotFound("only-on-b");
    return "ok";
  });
  assert.equal(value, "ok");
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(pool.snapshot().map((key) => key.state), ["healthy", "healthy"]);
  assert.deepEqual(pool.snapshot().map((key) => key.failures), [0, 0]);
});

test("owned-key runs have balanced accounting and fail safely when the key was removed", async () => {
  const pool = new CursorKeyPool(["a", "b"], { cooldownMs: 1000 });
  const value = await pool.runForId(fingerprintKey("b"), async (key) => `ok:${key}`);
  assert.equal(value, "ok:b");
  const status = pool.snapshot().find((key) => key.id === fingerprintKey("b"));
  assert.equal(status.requests, 1);
  assert.equal(status.successes, 1);
  assert.equal(status.active_requests, 0);
  await assert.rejects(
    pool.runForId(fingerprintKey("removed"), async () => "impossible"),
    (error) => error.code === "conversation_key_unavailable",
  );
});

test("key failures are classified and fingerprints never contain the key", () => {
  assert.equal(classifyKeyFailure(upstreamAuthError()), "auth");
  assert.equal(classifyKeyFailure(rateLimitError("x")), "rate_limit");
  assert.equal(classifyKeyFailure(cancelledError()), null);
  assert.equal(classifyKeyFailure(new Error("x")), null);
  const id = fingerprintKey("secret-cursor-key");
  assert.match(id, /^ck_[0-9a-f]{10}$/);
  assert.equal(id, fingerprintKey("secret-cursor-key"));
  assert.ok(!id.includes("secret"));
  assert.throws(() => new CursorKeyPool([" "], { cooldownMs: 1000 }));
});

test("gateway fails over from a revoked key and reports pool health", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({
    CURSOR_API_KEY: "bad-revoked-key",
    CURSOR_API_KEYS: "limited-key,good-key",
  });
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  try {
    for (const content of ["first", "second"]) {
      const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content }] }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal((await res.json()).choices[0].message.content, "PONG");
    }

    const models = await fetch(`${gateway.baseUrl}/v1/models`, { headers });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, "fake-model");

    const admin = await fetch(`${gateway.baseUrl}/admin/api/cursor-keys`, {
      headers: { authorization: "Bearer it-admin-key" },
    });
    assert.equal(admin.status, 200);
    const { keys } = await admin.json();
    assert.equal(keys.length, 3);
    assert.deepEqual(keys.map((key) => key.state), ["cooling_down", "cooling_down", "healthy"]);
    assert.equal(keys[0].last_failure, "auth");
    assert.equal(keys[1].last_failure, "rate_limit");
    const body = JSON.stringify(keys);
    assert.ok(!body.includes("good-key") && !body.includes("bad-revoked-key"));

    const overview = await fetch(`${gateway.baseUrl}/admin/api/overview`, {
      headers: { authorization: "Bearer it-admin-key" },
    });
    const summary = await overview.json();
    assert.deepEqual(summary.cursor_keys, { total: 3, healthy: 1 });
    assert.equal(summary.upstream, "ok");
    assert.match(gateway.output(), /cursor key pool enabled/);
  } finally {
    await gateway.stop();
  }
});

test("gateway returns the upstream error when every pooled key fails", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ CURSOR_API_KEY: "bad-one", CURSOR_API_KEYS: "bad-two" });
  try {
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "upstream_authentication_error");
  } finally {
    await gateway.stop();
  }
});
