import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { createKeyRateLimiter, KEY_RATE_LIMIT_WINDOW_MS } from "../dist/key-rate-limit.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const ADMIN_HEADERS = { authorization: "Bearer it-admin-key", "content-type": "application/json" };

function admit(limiter, keyId, now) {
  limiter.check(keyId, now);
  limiter.record(keyId, now);
}

function writeGatewayConfig(root, extraLines = []) {
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      ...extraLines,
      "",
    ].join("\n"),
  );
}

test("rate_limit_per_key defaults to zero and honors env over TOML", (context) => {
  const root = makeTempDir(context, "cursor-api-rpm-config-");
  writeGatewayConfig(root, ["rate_limit_per_key = 3"]);
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).rateLimitPerKey, 3);
  assert.equal(loadConfig({ DATA_DIR: "data", RATE_LIMIT_PER_KEY: "4" }, root).rateLimitPerKey, 4);

  const defaultRoot = makeTempDir(context, "cursor-api-rpm-default-");
  writeGatewayConfig(defaultRoot);
  assert.equal(loadConfig({ DATA_DIR: "data" }, defaultRoot).rateLimitPerKey, 0);
  for (const value of ["-1", "1.5", "nope", "9007199254740992"]) {
    assert.throws(
      () => loadConfig({ DATA_DIR: "data", RATE_LIMIT_PER_KEY: value }, defaultRoot),
      (error) => error instanceof Error && /RATE_LIMIT_PER_KEY/.test(error.message),
    );
  }
  for (const value of ["rate_limit_per_key = 1.5", "rate_limit_per_key = true"]) {
    const invalidTomlRoot = makeTempDir(context, "cursor-api-rpm-invalid-toml-");
    writeGatewayConfig(invalidTomlRoot, [value]);
    assert.throws(
      () => loadConfig({ DATA_DIR: "data" }, invalidTomlRoot),
      (error) => error instanceof Error && /rate_limit_per_key/.test(error.message),
    );
  }
});

test("disabled key rate limiting does not retain request history", () => {
  const limiter = createKeyRateLimiter(0);
  for (let index = 0; index < 100; index += 1) {
    admit(limiter, `key-${index}`, index);
  }
  assert.equal(limiter.size, 0);
});

test("request history is isolated per key and returns the OpenAI rate-limit error", () => {
  const limiter = createKeyRateLimiter(2);
  admit(limiter, "first", 1_000);
  admit(limiter, "first", 2_000);
  admit(limiter, "second", 2_000);

  assert.throws(
    () => limiter.check("first", 2_001),
    (error) => {
      assert.equal(error.httpStatus, 429);
      assert.equal(error.code, "rate_limit_exceeded");
      assert.equal(error.openaiType, "rate_limit_error");
      assert.equal(error.retryAfterSeconds, 59);
      return true;
    },
  );
  limiter.check("second", 2_001);
});

test("the oldest request leaves at the 60-second boundary and stale queues are reclaimed", () => {
  const limiter = createKeyRateLimiter(1);
  admit(limiter, "client", 5_000);

  assert.throws(
    () => limiter.check("client", 5_000 + KEY_RATE_LIMIT_WINDOW_MS - 1),
    (error) => error.retryAfterSeconds === 1,
  );
  limiter.check("client", 5_000 + KEY_RATE_LIMIT_WINDOW_MS);
  assert.equal(limiter.size, 0);

  admit(limiter, "client", 5_000 + KEY_RATE_LIMIT_WINDOW_MS);
  assert.equal(limiter.size, 1);
  limiter.check("client", 5_000 + KEY_RATE_LIMIT_WINDOW_MS * 2);
  assert.equal(limiter.size, 0);
});

test("an access-triggered sweep reclaims keys that have gone idle", () => {
  const limiter = createKeyRateLimiter(2);
  admit(limiter, "idle-a", 1_000);
  admit(limiter, "idle-b", 1_000);
  assert.equal(limiter.size, 2);

  limiter.check("active", 1_000 + KEY_RATE_LIMIT_WINDOW_MS);
  assert.equal(limiter.size, 0);
});

test("synchronous check and record admit at most the configured number in one window", () => {
  const limiter = createKeyRateLimiter(4);
  let admitted = 0;
  for (let index = 0; index < 20; index += 1) {
    try {
      admit(limiter, "same-client", 10_000);
      admitted += 1;
    } catch (error) {
      assert.equal(error.code, "rate_limit_exceeded");
    }
  }
  assert.equal(admitted, 4);
});

async function chat(gateway) {
  return fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hello" }] }),
  });
}

async function chatAs(gateway, key, body = {}) {
  return fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hello" }], ...body }),
  });
}

async function responsesAs(gateway, key, body = {}) {
  return fetch(`${gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", input: "hello", ...body }),
  });
}

test("RATE_LIMIT_PER_KEY caps Chat Completions per client key", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "1" });
  try {
    const first = await chat(gateway);
    assert.equal(first.status, 200);

    const second = await chat(gateway);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after") !== null, true);
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
    const body = await second.json();
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.code, "rate_limit_exceeded");
  } finally {
    await gateway.stop();
  }
});

test("Chat Completions and Responses share one per-key generation window", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "1" });
  try {
    assert.equal((await chat(gateway)).status, 200);
    const blocked = await responsesAs(gateway, CLIENT_KEY);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, "rate_limit_exceeded");
  } finally {
    await gateway.stop();
  }
});

test("health, model reads, admin reads, and Response retrieval do not consume RPM", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "2" });
  try {
    assert.equal((await fetch(`${gateway.baseUrl}/health`)).status, 200);
    assert.equal(
      (await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${gateway.baseUrl}/admin/api/keys`, { headers: ADMIN_HEADERS })).status,
      200,
    );

    const response = await responsesAs(gateway, CLIENT_KEY);
    assert.equal(response.status, 200);
    const stored = await response.json();
    assert.equal(
      (await fetch(`${gateway.baseUrl}/v1/responses/${encodeURIComponent(stored.id)}`, {
        headers: { authorization: `Bearer ${CLIENT_KEY}` },
      })).status,
      200,
    );

    assert.equal((await chat(gateway)).status, 200);
    assert.equal(
      (await fetch(`${gateway.baseUrl}/v1/models/fake-model`, {
        headers: { authorization: `Bearer ${CLIENT_KEY}` },
      })).status,
      200,
    );
    assert.equal((await chat(gateway)).status, 429);
  } finally {
    await gateway.stop();
  }
});

test("a streamed generation consumes one slot and a later block stays JSON before SSE", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "1" });
  try {
    const first = await chatAs(gateway, CLIENT_KEY, { stream: true });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /text\/event-stream/);
    await first.text();

    const blocked = await chatAs(gateway, CLIENT_KEY, { stream: true });
    assert.equal(blocked.status, 429);
    assert.doesNotMatch(blocked.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal((await blocked.json()).error.code, "rate_limit_exceeded");
  } finally {
    await gateway.stop();
  }
});

test("different client keys have independent generation windows", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "1" });
  try {
    assert.equal((await chat(gateway)).status, 200);
    const created = await fetch(`${gateway.baseUrl}/admin/api/keys`, {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ name: "second-client" }),
    });
    assert.equal(created.status, 201);
    const secondKey = (await created.json()).key;
    assert.equal(typeof secondKey, "string");
    assert.equal((await chatAs(gateway, secondKey)).status, 200);
    assert.equal((await chat(gateway)).status, 429);
  } finally {
    await gateway.stop();
  }
});

test("quota rejection does not consume the per-key rate-limit slot", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway(
    { RATE_LIMIT_PER_KEY: "1" },
    { keyPolicy: { quota_requests: 0 } },
  );
  try {
    const quotaBlocked = await chat(gateway);
    assert.equal(quotaBlocked.status, 429);
    assert.equal((await quotaBlocked.json()).error.code, "insufficient_quota");

    const updated = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ quota_requests: null }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await chat(gateway)).status, 200);
  } finally {
    await gateway.stop();
  }
});

test("invalid generation input and authentication failures do not consume RPM", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "1" });
  try {
    const invalid = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);

    const unauthorized = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer invalid-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await chat(gateway)).status, 200);
    assert.equal((await chat(gateway)).status, 429);
  } finally {
    await gateway.stop();
  }
});

test("zero disables per-key rate limiting", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ RATE_LIMIT_PER_KEY: "0" });
  try {
    assert.equal((await chat(gateway)).status, 200);
    assert.equal((await responsesAs(gateway, CLIENT_KEY)).status, 200);
    assert.equal((await chat(gateway)).status, 200);
  } finally {
    await gateway.stop();
  }
});
