// SAF-95 #40 review round 1 (Elliot): F1 abort charging, F2 token reservation, F3 suspended runs,
// F4 DST resets, F5 orphan usage, F6 quota_tz, F7 precheck stats, F8 user_version, mutants
// K10 / K12 / K20 / K24. Offline (fake SDK).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { getApiKeyById, getKeyUsageRow, insertApiKey, openDb, SCHEMA_VERSION } from "../dist/db.js";
import {
  admitKeyRequest,
  canonicalTimeZone,
  estimateTokens,
  holdParkedSlot,
  isCatalogModelAllowed,
  matchesAllowlist,
  periodKey,
  periodResetsAt,
  QUOTA_RESERVE_OUTPUT_TOKENS,
  reservationFor,
  runScopedUsageSource,
} from "../dist/key-policy.js";
import { CursorKeyPool } from "../dist/keypool.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const ADMIN = { authorization: "Bearer it-admin-key", "content-type": "application/json" };
const HEADERS = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const TOOLS = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];

function freshDb() {
  return openDb(mkdtempSync(join(tmpdir(), "key-policy-r1-")));
}

function seed(db, id, policy = {}) {
  const now = new Date().toISOString();
  insertApiKey(db, { id, name: id, key_prefix: `cgk_${id}`, key_digest: `digest-${id}`, created_at: now, updated_at: now, ...policy });
  return getApiKeyById(db, id);
}

const finished = (tokens, extra = {}) => ({
  text: "x",
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: tokens },
  usageKnown: true,
  usageScope: "run",
  status: "finished",
  finish_reason: "stop",
  ...extra,
});

async function usageOf(gateway) {
  const res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage`, { headers: ADMIN });
  return (await res.json()).current;
}

async function waitFor(check, label, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const routes = {
  chat: (stream) => ["/v1/chat/completions", { model: "fake-model", stream, messages: [{ role: "user", content: "SLOW_STREAM" }] }],
  responses: (stream) => ["/v1/responses", { model: "fake-model", stream, input: "SLOW_STREAM" }],
  messages: (stream) => ["/v1/messages", { model: "fake-model", stream, max_tokens: 64, messages: [{ role: "user", content: "SLOW_STREAM" }] }],
};

/** Starts a slow request, aborts it once output has started (stream) or after 200 ms. */
async function abortMidRun(gateway, path, body) {
  const controller = new AbortController();
  const res = fetch(`${gateway.baseUrl}${path}`, {
    method: "POST",
    headers: { ...HEADERS, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (body.stream) {
    const response = await res;
    const reader = response.body.getReader();
    let seen = "";
    while (!seen.includes("chunk")) seen += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
  }
  await res.catch(() => undefined);
}

// --- F1 -----------------------------------------------------------------------------------------

test("F1: a client abort after the run started charges run usage on every route", { timeout: 60_000 }, async () => {
  const gateway = await startFakeGateway({}, { keyPolicy: { quota_tokens: 1_000_000 } });
  try {
    let expected = 0;
    for (const [name, make] of Object.entries(routes)) {
      for (const stream of [true, false]) {
        const before = await usageOf(gateway);
        await abortMidRun(gateway, ...make(stream));
        const after = await waitFor(async () => {
          const usage = await usageOf(gateway);
          return usage.requests === before.requests + 1 && usage.tokens === before.tokens + 13 ? usage : undefined;
        }, `${name} stream=${String(stream)} charged`);
        expected += 13;
        assert.equal(after.tokens, expected, `${name} stream=${String(stream)}`);
      }
    }
  } finally {
    await gateway.stop();
  }
});

test("F1: without usage after cancel, the estimate (input + streamed text) is charged", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ FAKE_SDK_NO_USAGE_ON_CANCEL: "1" }, { keyPolicy: { quota_tokens: 1_000_000 } });
  try {
    await abortMidRun(gateway, ...routes.chat(true));
    const usage = await waitFor(async () => {
      const current = await usageOf(gateway);
      return current.tokens > 0 && current.tokens < QUOTA_RESERVE_OUTPUT_TOKENS ? current : undefined;
    }, "estimate charged and reservation released");
    // "SLOW_STREAM" (11 chars) + at least one "chunk " (6) → ≥ 5 tokens.
    assert.ok(usage.tokens >= estimateTokens(17), String(usage.tokens));
  } finally {
    await gateway.stop();
  }
});

test("usage source: run usage minus pre-charged rounds, else estimate, else null", () => {
  assert.equal(runScopedUsageSource(finished(13)), 13);
  assert.equal(runScopedUsageSource(finished(13, { quota_precharged_tokens: 5 })), 8);
  assert.equal(runScopedUsageSource(finished(3, { quota_precharged_tokens: 5 })), 0);
  assert.equal(runScopedUsageSource(finished(99, { usageScope: "agent_total", quota_estimate_tokens: 7 })), 7);
  assert.equal(runScopedUsageSource({ ...finished(0), usageKnown: false, quota_estimate_tokens: 4 }), 4);
  assert.equal(runScopedUsageSource({ ...finished(0), usageKnown: false }), null);
});

// --- F2 -----------------------------------------------------------------------------------------

test("F2: tokens are reserved at admission and trued up on finish (refunded when not started)", () => {
  const db = freshDb();
  const key = seed(db, "r1", { quota_tokens: 20 });
  const first = admitKeyRequest(db, key, Date.now(), { reserveTokens: 1100 });
  assert.equal(first.reservedTokens, 1100);
  assert.equal(getKeyUsageRow(db, "r1", "total").tokens, 1100);
  assert.throws(() => admitKeyRequest(db, key, Date.now(), { reserveTokens: 1100 }), (error) => error.httpStatus === 429 && /tokens 1100\/20/.test(error.message));
  first.markStarted();
  first.finish(finished(13));
  assert.equal(getKeyUsageRow(db, "r1", "total").tokens, 13);
  const notStarted = admitKeyRequest(db, key, Date.now(), { reserveTokens: 500 });
  notStarted.finish(null);
  assert.deepEqual([getKeyUsageRow(db, "r1", "total").requests, getKeyUsageRow(db, "r1", "total").tokens], [1, 13]);
  const lost = admitKeyRequest(db, key, Date.now(), { reserveTokens: 40 });
  lost.markStarted();
  lost.finish(null); // started, nothing known: the reservation stays as the charge
  assert.equal(getKeyUsageRow(db, "r1", "total").tokens, 53);
  const unlimited = seed(db, "r2", { quota_requests: 5 });
  assert.equal(admitKeyRequest(db, unlimited, Date.now(), { reserveTokens: 999 }).reservedTokens, 0, "no token quota, no reservation");
  db.close();
});

test("reservationFor: input estimate plus the fixed output allowance", () => {
  const reserve = reservationFor({ messages: [{ role: "user", content: "x".repeat(400) }] });
  assert.equal(reserve, 100 + QUOTA_RESERVE_OUTPUT_TOKENS);
});

test("F2 e2e: 30 concurrent requests cannot overspend a small token quota", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({}, { keyPolicy: { quota_tokens: 20 } });
  try {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }) }).then((res) => res.status),
      ),
    );
    const ok = results.filter((status) => status === 200).length;
    assert.ok(ok >= 1 && ok <= 2, `admitted ${String(ok)}`);
    const usage = await usageOf(gateway);
    assert.ok(usage.tokens <= 20 + 13, `used ${String(usage.tokens)} (bound: quota + one request)`);
  } finally {
    await gateway.stop();
  }
});

// --- F3 / K24 -----------------------------------------------------------------------------------

test("F3 + K24: a suspended tool round is charged and holds the slot; resuming is counted", { timeout: 60_000 }, async () => {
  const gateway = await startFakeGateway({ PARK_TIMEOUT_MS: "5000" }, { keyPolicy: { quota_tokens: 1_000_000, max_concurrent: 1 } });
  const chat = (messages, extra = {}) =>
    fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", tools: TOOLS, messages, ...extra }) });
  try {
    const user = { role: "user", content: "CALL_TOOL" };
    let res = await chat([user]);
    const parked = await res.json();
    assert.equal(parked.choices[0].finish_reason, "tool_calls");
    const call = parked.choices[0].message.tool_calls[0];
    const afterPark = await usageOf(gateway);
    assert.equal(afterPark.requests, 1);
    assert.ok(afterPark.tokens > 0 && afterPark.tokens < 13, `estimate charged at suspension: ${String(afterPark.tokens)}`);

    res = await chat([{ role: "user", content: "hi" }]);
    assert.equal(res.status, 429, "the parked agent holds the only slot");
    assert.equal((await res.json()).error.code, "concurrency_limit_exceeded");

    res = await chat([user, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "sunny" }]);
    assert.equal(res.status, 200, "tool results continue the parked run (its slot is adopted)");
    assert.match((await res.json()).choices[0].message.content, /sunny/);
    const afterResume = await usageOf(gateway);
    assert.equal(afterResume.requests, 2, "K24: the continuation counts as a started request");
    assert.equal(afterResume.tokens, 13, "run usage 13 minus the estimate already charged");

    // A round that is never resumed keeps its charge and frees the slot on expiry.
    res = await chat([{ role: "user", content: "CALL_TOOL again" }]);
    assert.equal((await res.json()).choices[0].finish_reason, "tool_calls");
    const charged = (await usageOf(gateway)).tokens;
    assert.ok(charged > 13);
    assert.equal((await chat([{ role: "user", content: "hi" }])).status, 429);
    await waitFor(async () => (await chat([{ role: "user", content: "hi" }])).status === 200, "slot freed after park timeout", 12_000);
    assert.ok((await usageOf(gateway)).tokens >= charged);
  } finally {
    await gateway.stop();
  }
});

test("parked slots count toward max_concurrent unless the request resumes that agent", () => {
  const db = freshDb();
  const key = seed(db, "p1", { max_concurrent: 1 });
  const release = holdParkedSlot("p1");
  assert.throws(() => admitKeyRequest(db, key), (error) => error.code === "concurrency_limit_exceeded");
  const resumed = admitKeyRequest(db, key, Date.now(), { resumesParked: true });
  release();
  release(); // idempotent
  resumed.finish(null);
  admitKeyRequest(db, key).finish(null);
  db.close();
});

// --- K10 / K12 / K20 / F5 -----------------------------------------------------------------------

test("K10: a quota-only key prechecks the model before charging (404 costs nothing)", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({}, { keyPolicy: { quota_requests: 5 } });
  try {
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 404);
    const usage = await usageOf(gateway);
    assert.equal(usage.requests, 0);
  } finally {
    await gateway.stop();
  }
});

test("K12: allowlist matching ignores case on both sides", () => {
  assert.equal(matchesAllowlist(["fake-model"], "FAKE-MODEL"), true);
  assert.equal(matchesAllowlist(["FAKE-*"], "fake-reasoner"), true);
  assert.equal(isCatalogModelAllowed({ allowedModels: ["Fake-Model"], allowMaxMode: null }, "FAKE-MODEL", "fake-model"), true);
  assert.equal(isCatalogModelAllowed({ allowedModels: ["Gemini-Flash"], allowMaxMode: null }, "gemini-flash", "gemini-2.5-flash"), true);
});

test("K20 + F5: deleting a key clears its usage, also when a request is still running", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({}, { keyPolicy: { quota_tokens: 1_000_000 } });
  const rows = () => {
    const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"));
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM api_key_usage WHERE api_key_id = 'it-key'").get().n;
    } finally {
      db.close();
    }
  };
  try {
    await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(rows(), 1);
    const running = fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "SLOW_STREAM" }] }) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, { method: "DELETE", headers: ADMIN });
    assert.equal(res.status, 200);
    assert.equal(rows(), 0, "K20: usage removed with the key");
    await running;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rows(), 0, "F5: settling the in-flight request does not recreate an orphan row");
  } finally {
    await gateway.stop();
  }
});

// --- F4 / F6 ------------------------------------------------------------------------------------

test("F4: resets_at is the first instant of the next local day, also where DST skips midnight", () => {
  for (const tz of ["America/Havana", "Atlantic/Azores", "America/Santiago", "America/Asuncion", "Asia/Singapore", "UTC", "America/New_York"]) {
    for (let day = 0; day < 366; day += 1) {
      const now = Date.UTC(2026, 0, 1, 15) + day * 86_400_000;
      const reset = periodResetsAt("daily", tz, now).getTime();
      assert.notEqual(periodKey("daily", tz, reset), periodKey("daily", tz, now), `${tz} ${new Date(now).toISOString()}`);
      assert.equal(periodKey("daily", tz, reset - 1000), periodKey("daily", tz, now), `${tz} ${new Date(now).toISOString()} not early`);
    }
    const monthly = periodResetsAt("monthly", tz, Date.UTC(2026, 2, 15)).getTime();
    assert.notEqual(periodKey("monthly", tz, monthly), periodKey("monthly", tz, Date.UTC(2026, 2, 15)));
    assert.equal(periodKey("monthly", tz, monthly - 1000), periodKey("monthly", tz, Date.UTC(2026, 2, 15)));
  }
  // Havana 2026-03-08 00:00 does not exist (clocks jump to 01:00 CDT = 05:00Z).
  assert.equal(periodResetsAt("daily", "America/Havana", Date.parse("2026-03-07T17:00:00Z")).toISOString(), "2026-03-08T05:00:00.000Z");
});

test("F6: quota_tz is stored canonical; offsets and junk are rejected; bad stored values fall back to UTC", async () => {
  assert.equal(canonicalTimeZone("asia/singapore"), "Asia/Singapore");
  assert.equal(canonicalTimeZone(" UTC "), "UTC");
  for (const bad of ["+08:00", "-0500", "UTC+8", "", "Not/AZone", "../etc", 42]) assert.equal(canonicalTimeZone(bad), undefined, String(bad));
  assert.doesNotThrow(() => periodKey("daily", "Bogus/Zone"));
  assert.equal(periodKey("daily", "Bogus/Zone", Date.UTC(2026, 9, 20, 23)), "d:2026-10-20");

  const gateway = await startFakeGateway();
  try {
    let res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, { method: "PATCH", headers: ADMIN, body: JSON.stringify({ quota_tz: "+08:00" }) });
    assert.equal(res.status, 400);
    res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, { method: "PATCH", headers: ADMIN, body: JSON.stringify({ quota_tz: "asia/singapore" }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).quota_tz, "Asia/Singapore");
  } finally {
    await gateway.stop();
  }
});

// --- F7 / F8 ------------------------------------------------------------------------------------

test("F7: prechecks (record:false) do not count requests or rotate the pool", async () => {
  const pool = new CursorKeyPool(["a", "b"], { cooldownMs: 1000 });
  assert.equal(await pool.run(async (key) => key, undefined, { record: false }), "a");
  assert.equal(await pool.run(async (key) => key, undefined, { record: false }), "a", "no rotation step");
  assert.deepEqual(pool.snapshot().map((entry) => entry.requests), [0, 0]);
  assert.equal(await pool.run(async (key) => key), "a");
  assert.equal(await pool.run(async (key) => key), "b");
  assert.deepEqual(pool.snapshot().map((entry) => entry.requests), [1, 1]);
});

test("F8: PRAGMA user_version records the schema version", () => {
  const db = freshDb();
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  db.close();
});

test("P3: admin returns the effective max-mode permission and warns when the gateway ceiling wins", { timeout: 20_000 }, async () => {
  const patch = (gateway, body) =>
    fetch(`${gateway.baseUrl}/admin/api/keys/it-key`, { method: "PATCH", headers: { ...ADMIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  let gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false" });
  try {
    let body = await (await patch(gateway, { allow_max_mode: true })).json();
    assert.equal(body.allow_max_mode, true);
    assert.equal(body.effective_allow_max_mode, false);
    assert.match(body.warnings?.[0] ?? "", /hard ceiling/);
    const listed = (await (await fetch(`${gateway.baseUrl}/admin/api/keys`, { headers: ADMIN })).json()).keys.find((k) => k.id === "it-key");
    assert.equal(listed.effective_allow_max_mode, false);
    body = await (await patch(gateway, { allow_max_mode: null })).json();
    assert.equal(body.effective_allow_max_mode, false);
    assert.equal(body.warnings, undefined, "inherit is not a misconfiguration");
  } finally {
    await gateway.stop();
  }
  gateway = await startFakeGateway();
  try {
    let body = await (await patch(gateway, { allow_max_mode: false })).json();
    assert.deepEqual([body.effective_allow_max_mode, body.warnings], [false, undefined]);
    body = await (await patch(gateway, { allow_max_mode: true })).json();
    assert.deepEqual([body.effective_allow_max_mode, body.warnings], [true, undefined]);
  } finally {
    await gateway.stop();
  }
});
