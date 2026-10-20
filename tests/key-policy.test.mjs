// SAF-95: per client key model allowlist, max-mode override, request / token quotas and concurrency.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { configureMaxMode, resolveCatalogModelSelection } from "../dist/cursor.js";
import {
  addKeyTokens,
  getApiKeyById,
  getKeyUsageRow,
  insertApiKey,
  openDb,
  reserveKeyRequest,
  updateApiKeyPolicy,
} from "../dist/db.js";
import {
  admitKeyRequest,
  inFlightRequests,
  isCatalogModelAllowed,
  isListedModelAllowed,
  matchesAllowlist,
  parseAllowedModelsInput,
  periodKey,
  periodResetsAt,
} from "../dist/key-policy.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const ADMIN = { authorization: "Bearer it-admin-key", "content-type": "application/json" };

function freshDb() {
  return openDb(mkdtempSync(join(tmpdir(), "key-policy-")));
}

function seed(db, id, policy = {}) {
  const now = new Date().toISOString();
  insertApiKey(db, { id, name: id, key_prefix: `cgk_${id}`, key_digest: `digest-${id}`, created_at: now, updated_at: now, ...policy });
  return getApiKeyById(db, id);
}

function api(gateway) {
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  const post = (path, body) => fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return {
    chat: (body) => post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], ...body }),
    responses: (body) => post("/v1/responses", body),
    messages: (body) =>
      fetch(`${gateway.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...headers, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...body }),
      }),
    models: () => fetch(`${gateway.baseUrl}/v1/models`, { headers }),
    model: (id) => fetch(`${gateway.baseUrl}/v1/models/${encodeURIComponent(id)}`, { headers }),
    admin: (method, path, body) =>
      fetch(`${gateway.baseUrl}${path}`, { method, headers: ADMIN, ...(body ? { body: JSON.stringify(body) } : {}) }),
  };
}

// --- Allowlist ---------------------------------------------------------------------------------

test("allowlist: exact, case-insensitive, * wildcards, null = unrestricted", () => {
  assert.equal(matchesAllowlist(null, "anything"), true);
  assert.equal(matchesAllowlist([], "fake-model"), false, "empty list allows nothing");
  assert.equal(matchesAllowlist(["Fake-Model"], "fake-model"), true);
  assert.equal(matchesAllowlist(["fake-*"], "fake-reasoner"), true);
  assert.equal(matchesAllowlist(["fake-*"], "other"), false);
  assert.equal(matchesAllowlist(["*-flash"], "gemini-2.5-flash"), true);
  assert.equal(matchesAllowlist(["gemini-2.5-flash"], "gemini-2.5-flash-lite"), false, "exact is anchored");
  assert.equal(matchesAllowlist(["a.b"], "aXb"), false, "regex metacharacters are literal");
  assert.equal(matchesAllowlist(["*"], "x"), true);
});

test("allowlist: catalog aliases only unlock via an exact entry, never via a glob", () => {
  const policy = (allowedModels) => ({ allowedModels, allowMaxMode: null });
  assert.equal(isCatalogModelAllowed(policy(["fake-model"]), "fake-alias", "fake-model"), true, "canonical id wins");
  assert.equal(isCatalogModelAllowed(policy(["fake-alias"]), "fake-alias", "fake-model"), true, "exact alias entry");
  assert.equal(isCatalogModelAllowed(policy(["fake-a*"]), "fake-alias", "fake-model"), false, "glob cannot match the alias");
  assert.equal(isCatalogModelAllowed(policy(["fake-model"]), "fake-model", "fake-model"), true);
  assert.equal(isCatalogModelAllowed(policy(["fake-max"]), "fake-model", "fake-model"), false);
  assert.equal(isListedModelAllowed(policy(["fake-alias"]), { id: "fake-model", aliases: ["fake-alias"] }), true);
  assert.equal(isListedModelAllowed(policy(["fake-a*"]), { id: "fake-model", aliases: ["fake-alias"] }), false);
});

test("allowlist is enforced inside model selection (after catalog alias resolution)", () => {
  configureMaxMode({ allowMaxMode: true });
  const catalog = [{ id: "fake-model", aliases: ["fake-alias"], parameters: [], variants: [] }];
  const request = (model) => parseChatCompletionsRequest({ model, messages: [{ role: "user", content: "hi" }] });
  assert.throws(
    () => resolveCatalogModelSelection(catalog, request("fake-alias"), { allowedModels: ["other"] }),
    (error) => error.httpStatus === 403 && error.code === "model_not_allowed" && error.param === "model",
  );
  assert.equal(resolveCatalogModelSelection(catalog, request("FAKE-ALIAS"), { allowedModels: ["fake-model"] }).id, "fake-model");
  assert.equal(resolveCatalogModelSelection(catalog, request("fake-model"), { allowedModels: null }).id, "fake-model");
});

test("parseAllowedModelsInput validates and dedupes", () => {
  assert.equal(parseAllowedModelsInput(null), null);
  assert.deepEqual(parseAllowedModelsInput([" a ", "A", "b*"]), ["a", "b*"]);
  assert.throws(() => parseAllowedModelsInput("a"), /array/);
  assert.throws(() => parseAllowedModelsInput([""]), /non-empty/);
  assert.throws(() => parseAllowedModelsInput(["x".repeat(257)]), /256/);
  assert.throws(() => parseAllowedModelsInput(Array.from({ length: 201 }, (_, i) => `m${i}`)), /200/);
  assert.throws(() => parseAllowedModelsInput(["a\nb"]), /control/);
});

// --- Per-key max mode override ------------------------------------------------------------------

test("per-key allow_max_mode: null inherits the gateway, true/false override it", () => {
  const catalog = [
    {
      id: "fake-maxonly",
      parameters: [{ id: "context", values: [{ value: "1m" }] }],
      variants: [{ displayName: "M", isDefault: true, isMaxMode: true, params: [{ id: "context", value: "1m" }] }],
    },
  ];
  const request = parseChatCompletionsRequest({ model: "fake-maxonly", messages: [{ role: "user", content: "hi" }] });
  try {
    configureMaxMode({ allowMaxMode: true });
    assert.equal(resolveCatalogModelSelection(catalog, request, { allowMaxMode: null }).maxMode, true);
    assert.throws(() => resolveCatalogModelSelection(catalog, request, { allowMaxMode: false }), /max mode/);
    configureMaxMode({ allowMaxMode: false });
    assert.throws(() => resolveCatalogModelSelection(catalog, request, { allowMaxMode: null }), /max mode/);
    assert.equal(resolveCatalogModelSelection(catalog, request, { allowMaxMode: true }).maxMode, true, "key can opt in");
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
});

// --- Periods ------------------------------------------------------------------------------------

test("period keys and reset instants honour the IANA time zone", () => {
  const t = Date.parse("2026-10-20T17:30:00Z"); // 01:30 on 21 Oct in Singapore
  assert.equal(periodKey("total", "UTC", t), "total");
  assert.equal(periodKey("daily", "UTC", t), "d:2026-10-20");
  assert.equal(periodKey("daily", "Asia/Singapore", t), "d:2026-10-21");
  assert.equal(periodKey("monthly", "UTC", Date.parse("2026-10-31T20:00:00Z")), "m:2026-10");
  assert.equal(periodKey("monthly", "Asia/Singapore", Date.parse("2026-10-31T20:00:00Z")), "m:2026-11");
  assert.equal(periodResetsAt("total", "UTC", t), null);
  assert.equal(periodResetsAt("daily", "UTC", t).toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(periodResetsAt("daily", "Asia/Singapore", t).toISOString(), "2026-10-21T16:00:00.000Z");
  assert.equal(periodResetsAt("monthly", "UTC", t).toISOString(), "2026-11-01T00:00:00.000Z");
  // DST: New York falls back on 1 Nov 2026; local midnight of 2 Nov is 05:00Z.
  assert.equal(periodResetsAt("daily", "America/New_York", Date.parse("2026-11-01T12:00:00Z")).toISOString(), "2026-11-02T05:00:00.000Z");
});

// --- Admission ----------------------------------------------------------------------------------

test("request quota boundary, Retry-After and period rollover", () => {
  const db = freshDb();
  const key = seed(db, "k1", { quota_requests: 2, quota_period: "daily", quota_tz: "UTC" });
  const day1 = Date.parse("2026-10-20T23:59:00Z");
  admitKeyRequest(db, key, day1).markStarted();
  const second = admitKeyRequest(db, key, day1);
  second.markStarted();
  second.finish(null);
  assert.throws(
    () => admitKeyRequest(db, key, day1),
    (error) => error.httpStatus === 429 && error.code === "insufficient_quota" && error.retryAfterSeconds === 60,
  );
  assert.equal(getKeyUsageRow(db, "k1", "d:2026-10-20").requests, 2);
  const day2 = admitKeyRequest(db, key, Date.parse("2026-10-21T00:00:01Z"));
  assert.equal(day2.period, "d:2026-10-21", "a new period starts from zero");
  day2.finish(null);
  db.close();
});

test("refund when the upstream run never started; tokens post-charged when it did", () => {
  const db = freshDb();
  const key = seed(db, "k2", { quota_requests: 5, quota_tokens: 100 });
  const notStarted = admitKeyRequest(db, key);
  assert.equal(getKeyUsageRow(db, "k2", "total").requests, 1);
  notStarted.finish(null);
  notStarted.finish(null);
  assert.equal(getKeyUsageRow(db, "k2", "total").requests, 0, "refunded exactly once");
  const ran = admitKeyRequest(db, key);
  ran.markStarted();
  ran.finish({ usage: { total_tokens: 42 }, usageKnown: true, usageScope: "run" });
  assert.deepEqual([getKeyUsageRow(db, "k2", "total").requests, getKeyUsageRow(db, "k2", "total").tokens], [1, 42]);
  const cumulative = admitKeyRequest(db, key);
  cumulative.markStarted();
  cumulative.finish({ usage: { total_tokens: 999 }, usageKnown: true, usageScope: "agent_total" });
  assert.equal(getKeyUsageRow(db, "k2", "total").tokens, 42, "agent totals are not charged (would double count)");
  db.close();
});

test("token quota is a soft cap: admitted while below, rejected once reached", () => {
  const db = freshDb();
  const key = seed(db, "k3", { quota_tokens: 50 });
  addKeyTokens(db, "k3", "total", 49);
  admitKeyRequest(db, key).finish(null);
  addKeyTokens(db, "k3", "total", 1);
  assert.throws(() => admitKeyRequest(db, key), (error) => error.httpStatus === 429 && /tokens 50\/50/.test(error.message));
  db.close();
});

test("concurrency cap and no overspend across connections to the same database", () => {
  const dir = mkdtempSync(join(tmpdir(), "key-policy-multi-"));
  const db = openDb(dir);
  const key = seed(db, "k4", { max_concurrent: 2 });
  const a = admitKeyRequest(db, key);
  const b = admitKeyRequest(db, key);
  assert.throws(() => admitKeyRequest(db, key), (error) => error.httpStatus === 429 && error.code === "concurrency_limit_exceeded");
  a.finish(null);
  assert.equal(inFlightRequests("k4"), 1);
  admitKeyRequest(db, key).finish(null);
  b.finish(null);
  assert.equal(inFlightRequests("k4"), 0);

  // Two independent connections (as two gateway processes would have) race for 10 slots.
  seed(db, "k5", { quota_requests: 10 });
  const other = new DatabaseSync(join(dir, "cursor-api.sqlite"), { timeout: 5000 });
  let ok = 0;
  for (let i = 0; i < 40; i += 1) {
    const conn = i % 2 === 0 ? db : other;
    if (reserveKeyRequest(conn, "k5", "total", { quotaRequests: 10, quotaTokens: null }).ok) ok += 1;
  }
  assert.equal(ok, 10);
  assert.equal(getKeyUsageRow(db, "k5", "total").requests, 10);
  other.close();
  db.close();
});

test("keys without quota or concurrency limits never touch api_key_usage", () => {
  const db = freshDb();
  const key = seed(db, "k6", { allowed_models: ["x"] });
  const ticket = admitKeyRequest(db, key);
  ticket.markStarted();
  ticket.finish({ usage: { total_tokens: 10 }, usageKnown: true, usageScope: "run" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM api_key_usage").get().n, 0);
  db.close();
});

// --- Migration ----------------------------------------------------------------------------------

test("migration: pre-SAF-95 keys come up unrestricted, and corrupt allowlists fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "key-policy-mig-"));
  const old = new DatabaseSync(join(dir, "cursor-api.sqlite"));
  old.exec(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key_prefix TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1, request_limit INTEGER NOT NULL, used_requests INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO api_keys VALUES ('legacy','legacy','cgk_legacy','d-legacy',1,0,0,'2026-01-01','2026-01-01');`);
  old.close();
  const db = openDb(dir);
  const key = getApiKeyById(db, "legacy");
  assert.deepEqual(
    [key.allowed_models, key.allow_max_mode, key.quota_requests, key.quota_tokens, key.quota_period, key.quota_tz, key.max_concurrent],
    [null, null, null, null, "total", "UTC", null],
  );
  db.close();
  const reopened = openDb(dir); // idempotent
  reopened.prepare("UPDATE api_keys SET allowed_models = 'not json' WHERE id = 'legacy'").run();
  assert.deepEqual(getApiKeyById(reopened, "legacy").allowed_models, [], "corrupt allowlist denies everything");
  assert.equal(updateApiKeyPolicy(reopened, "legacy", { allowed_models: null }).allowed_models, null);
  reopened.close();
});

// --- End to end through the gateway (fake SDK) --------------------------------------------------

test("e2e: allowlist on every route, /v1/models filtered, gateway alias cannot bypass", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway(
    { MODEL_ALIASES: "claude-opus-*=fake-reasoner" },
    { keyPolicy: { allowed_models: ["fake-model"] } },
  );
  const c = api(gateway);
  try {
    let res = await c.chat({ model: "fake-model" });
    assert.equal(res.status, 200, await res.clone().text());
    res = await c.chat({ model: "fake-alias" });
    assert.equal(res.status, 200, "catalog alias resolving to an allowed id");
    for (const send of [
      () => c.chat({ model: "fake-reasoner" }),
      () => c.chat({ model: "fake-reasoner", stream: true }),
      () => c.chat({ model: "claude-opus-4" }),
      () => c.responses({ model: "fake-reasoner", input: "hi" }),
      () => c.messages({ model: "claude-opus-4" }),
    ]) {
      res = await send();
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.ok(body.error.code === "model_not_allowed" || body.error.type === "permission_error", JSON.stringify(body));
    }
    res = await c.models();
    assert.deepEqual((await res.json()).data.map((m) => m.id), ["fake-model"]);
    assert.equal((await c.model("fake-reasoner")).status, 404);
    assert.equal((await c.model("fake-model")).status, 200);
  } finally {
    await gateway.stop();
  }
});

test("e2e: request quota, no overspend under parallel load, 429 with Retry-After, refund", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway(
    { FAKE_SDK_DELAY_MS: "50" },
    { keyPolicy: { quota_requests: 3, quota_period: "daily", quota_tz: "Asia/Singapore" } },
  );
  const c = api(gateway);
  try {
    let res = await c.chat({ model: "fake-model", messages: [{ role: "user", content: "FAIL_NETWORK" }] });
    assert.notEqual(res.status, 200);
    let usage = await (await c.admin("GET", "/admin/api/keys/it-key/usage")).json();
    assert.equal(usage.current.requests, 0, "failed before any run: refunded");

    const results = await Promise.all(Array.from({ length: 8 }, () => c.chat({ model: "fake-model" })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429, 429, 429]);
    const rejected = results.find((r) => r.status === 429);
    assert.ok(Number(rejected.headers.get("retry-after")) > 0);
    assert.equal((await rejected.json()).error.code, "insufficient_quota");
    usage = await (await c.admin("GET", "/admin/api/keys/it-key/usage")).json();
    assert.equal(usage.current.requests, 3);
    assert.equal(usage.current.tokens, 39, "13 tokens per fake run, run-scoped");
    assert.equal(usage.current.remaining_requests, 0);
    assert.ok(usage.current.resets_at.endsWith("T16:00:00.000Z"), "Singapore midnight");

    // A disallowed model is rejected with 403 before the quota (no 429, nothing charged).
    res = await c.admin("PATCH", "/admin/api/keys/it-key", { allowed_models: ["fake-model"] });
    assert.equal(res.status, 200);
    res = await c.chat({ model: "fake-reasoner" });
    assert.equal(res.status, 403);

    res = await c.admin("POST", "/admin/api/keys/it-key/usage/reset", {});
    assert.equal((await res.json()).current.requests, 0);
    assert.equal((await c.chat({ model: "fake-model" })).status, 200);
  } finally {
    await gateway.stop();
  }
});

test("e2e: token quota and concurrency cap", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ FAKE_SDK_DELAY_MS: "300" }, { keyPolicy: { quota_tokens: 20, max_concurrent: 1 } });
  const c = api(gateway);
  try {
    const [a, b] = await Promise.all([c.chat({ model: "fake-model" }), c.chat({ model: "fake-model" })]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 429]);
    const limited = a.status === 429 ? a : b;
    assert.equal((await limited.json()).error.code, "concurrency_limit_exceeded");
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal((await c.chat({ model: "fake-model" })).status, 200, "13 < 20 still admitted (soft cap)");
    const res = await c.chat({ model: "fake-model" });
    assert.equal(res.status, 429, "26 >= 20");
    assert.equal((await res.json()).error.code, "insufficient_quota");
  } finally {
    await gateway.stop();
  }
});

test("e2e: per-key allow_max_mode overrides ALLOW_MAX_MODE both ways", { timeout: 30_000 }, async () => {
  let gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false" }, { keyPolicy: { allow_max_mode: true } });
  try {
    const res = await api(gateway).chat({ model: "fake-maxonly", messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(JSON.parse((await res.json()).choices[0].message.content).sdk_max_mode, true);
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway({}, { keyPolicy: { allow_max_mode: false } });
  try {
    const c = api(gateway);
    let res = await c.chat({ model: "fake-maxonly" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    res = await c.chat({ model: "fake-max", messages: [{ role: "user", content: "ECHO_MAX" }] });
    assert.equal(JSON.parse((await res.json()).choices[0].message.content).sdk_max_mode, false, "falls back to non-max");
    res = await c.admin("PATCH", "/admin/api/keys/it-key", { allow_max_mode: null });
    assert.equal((await res.json()).allow_max_mode, null);
    res = await c.chat({ model: "fake-maxonly" });
    assert.equal(res.status, 200, "null inherits the default (allowed)");
  } finally {
    await gateway.stop();
  }
});

test("e2e admin API: auth, validation, create with policy, PATCH, usage, reset", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway();
  const c = api(gateway);
  try {
    for (const [method, path] of [
      ["PATCH", "/admin/api/keys/it-key"],
      ["GET", "/admin/api/keys/it-key/usage"],
      ["POST", "/admin/api/keys/it-key/usage/reset"],
    ]) {
      const noAuth = await fetch(`${gateway.baseUrl}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(noAuth.status, 401, `${method} ${path} without admin key`);
      const clientKey = await fetch(`${gateway.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(clientKey.status, 401, `${method} ${path} with a client key`);
    }
    for (const bad of [
      { allowed_models: "x" },
      { allow_max_mode: "yes" },
      { quota_requests: -1 },
      { quota_tokens: 1.5 },
      { quota_period: "weekly" },
      { quota_tz: "Mars/Olympus" },
      { max_concurrent: 0 },
      { name: "" },
    ]) {
      assert.equal((await c.admin("PATCH", "/admin/api/keys/it-key", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await c.admin("PATCH", "/admin/api/keys/missing", { quota_requests: 1 })).status, 404);
    assert.equal((await c.admin("GET", "/admin/api/keys/missing/usage")).status, 404);

    let res = await c.admin("POST", "/admin/api/keys", { name: "limited", allowed_models: ["fake-*"], quota_requests: 5, quota_period: "monthly", quota_tz: "Asia/Singapore", max_concurrent: 2 });
    assert.equal(res.status, 201, await res.clone().text());
    const created = await res.json();
    const createdKey = created;
    assert.match(created.key, /^cgk_/);
    assert.deepEqual(createdKey.allowed_models, ["fake-*"]);
    assert.equal(createdKey.quota_period, "monthly");

    res = await c.admin("PATCH", "/admin/api/keys/it-key", { name: "renamed", quota_requests: 7, allow_max_mode: false });
    const patched = await res.json();
    assert.equal(patched.name, "renamed");
    assert.equal(patched.quota_requests, 7);
    assert.equal(patched.allow_max_mode, false);
    assert.equal(patched.allowed_models, null, "omitted fields are untouched");
    assert.equal(patched.key_digest, undefined, "digest never leaves the server");
    assert.equal(patched.usage_current.remaining_requests, 7);

    res = await c.admin("GET", "/admin/api/keys");
    const listed = (await res.json()).keys.find((k) => k.id === "it-key");
    assert.equal(listed.quota_requests, 7);
    assert.equal(listed.usage_current.requests, 0);
  } finally {
    await gateway.stop();
  }
});

test("e2e: per-key allow_max_mode also governs the SDK-resolved max-mode check", { timeout: 30_000 }, async () => {
  let gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "agent" }, { keyPolicy: { allow_max_mode: true } });
  try {
    assert.equal((await api(gateway).chat({ model: "fake-model" })).status, 200, "key opts in: SDK max allowed");
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway({ FAKE_SDK_FORCE_MAX: "run" }, { keyPolicy: { allow_max_mode: false, quota_requests: 5 } });
  try {
    const c = api(gateway);
    const res = await c.chat({ model: "fake-model" });
    assert.equal(res.status, 403, "key opts out although the gateway allows max mode");
    assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    const usage = await (await c.admin("GET", "/admin/api/keys/it-key/usage")).json();
    assert.equal(usage.current.requests, 1, "the run reached upstream before it was cancelled, so it counts");
  } finally {
    await gateway.stop();
  }
});
