// Elliot #41 round 1: N1 (no silent max via non-exact effort), N2 (soft effort when max is off),
// N3 (weight wiring / rounding / admin bounds), N4 (integer TOML keys reject decimals). Offline.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureMaxMode, highestNonMaxEffort, resolveCatalogModelSelection, resolveChatParams, wasHintSoftened } from "../dist/cursor.js";
import { loadConfig } from "../dist/config.js";
import { runScopedUsageSource } from "../dist/key-policy.js";
import { insertApiKey, openDb, tokenStatsByKey } from "../dist/db.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { parseResponsesRequest } from "../dist/responses.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

// "max" exists only on the max variant.
const gapMax = {
  id: "gap-max",
  displayName: "Gap Max",
  parameters: [{ id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "max" }] }],
  variants: [
    { displayName: "Low", params: [{ id: "reasoning_effort", value: "low" }] },
    { displayName: "Medium", isDefault: true, params: [{ id: "reasoning_effort", value: "medium" }] },
    { displayName: "Max", isMaxMode: true, params: [{ id: "reasoning_effort", value: "max" }] },
  ],
};
// thinking=true only on the max variant.
const toggleMax = {
  id: "toggle-max",
  displayName: "Toggle Max",
  parameters: [{ id: "thinking", displayName: "Thinking", values: [{ value: "true" }, { value: "false" }] }],
  variants: [
    { displayName: "Plain", isDefault: true, params: [{ id: "thinking", value: "false" }] },
    { displayName: "Thinking Max", isMaxMode: true, params: [{ id: "thinking", value: "true" }] },
  ],
};
const chat = (body) => parseChatCompletionsRequest({ messages: [{ role: "user", content: "x" }], ...body });
const responses = (body) => parseResponsesRequest({ input: "x", ...body });
const paramsOf = (selection) => Object.fromEntries((selection.params ?? []).map((param) => [param.id, param.value]));
const is403 = (error) => error.httpStatus === 403 && error.code === "max_mode_not_allowed";

test("N1: non-exact effort never selects a max-only value, even with max mode allowed", () => {
  configureMaxMode({ allowMaxMode: true });
  for (const effort of ["xhigh", "high", "XHIGH"]) {
    const selection = resolveCatalogModelSelection([gapMax], chat({ model: "gap-max", reasoning_effort: effort }));
    assert.deepEqual(paramsOf(selection), { reasoning_effort: "medium" }, effort);
    assert.notEqual(selection.maxMode, true, effort);
    const hinted = resolveCatalogModelSelection([gapMax], responses({ model: "gap-max", reasoning: { effort } }));
    assert.deepEqual(paramsOf(hinted), { reasoning_effort: "medium" }, `responses ${effort}`);
    assert.notEqual(hinted.maxMode, true);
  }
  // Boolean thinking toggle: non-exact levels never switch on a max-only `true`.
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    const selection = resolveCatalogModelSelection([toggleMax], chat({ model: "toggle-max", reasoning_effort: effort }));
    assert.deepEqual(paramsOf(selection), { thinking: "false" }, effort);
    assert.notEqual(selection.maxMode, true, effort);
  }
  // Only an exact explicit request may reach max mode when it is allowed.
  const exact = resolveCatalogModelSelection([gapMax], chat({ model: "gap-max", reasoning_effort: "max" }));
  assert.deepEqual(paramsOf(exact), { reasoning_effort: "max" });
  assert.equal(exact.maxMode, true);
  const exactDisplay = resolveCatalogModelSelection([toggleMax], chat({ model: "toggle-max", reasoning_effort: "true" }));
  assert.equal(exactDisplay.maxMode, true, "exact 'true' is an explicit choice");
  assert.equal(highestNonMaxEffort(gapMax), "medium");
  assert.equal(highestNonMaxEffort(toggleMax), undefined, "boolean toggles have no level");
});

test("N2: with max mode off, chat reasoning_effort and Responses reasoning.effort both degrade (no 403)", () => {
  configureMaxMode({ allowMaxMode: false });
  try {
    for (const effort of ["max", "MAX", "xhigh"]) {
      const viaChat = chat({ model: "gap-max", reasoning_effort: effort });
      const selection = resolveCatalogModelSelection([gapMax], viaChat);
      assert.deepEqual(paramsOf(selection), { reasoning_effort: "medium" }, `chat ${effort}`);
      assert.notEqual(selection.maxMode, true);
      const viaResponses = responses({ model: "gap-max", reasoning: { effort } });
      assert.deepEqual(paramsOf(resolveCatalogModelSelection([gapMax], viaResponses)), { reasoning_effort: "medium" }, `responses ${effort}`);
    }
    const softened = chat({ model: "gap-max", reasoning_effort: "max" });
    resolveCatalogModelSelection([gapMax], softened);
    assert.equal(wasHintSoftened(softened), true);
    // Explicit max-only params / variants are still hard errors.
    assert.throws(() => resolveCatalogModelSelection([gapMax], chat({ model: "gap-max", variant: "Max" })), is403);
    assert.throws(() => resolveCatalogModelSelection([gapMax], chat({ model: "gap-max", params: [{ id: "reasoning_effort", value: "max" }] })), is403);
    // Per-key restriction behaves the same as the global flag.
    configureMaxMode({ allowMaxMode: true });
    const perKey = resolveCatalogModelSelection([gapMax], chat({ model: "gap-max", reasoning_effort: "max" }), { allowMaxMode: false });
    assert.deepEqual(paramsOf(perKey), { reasoning_effort: "medium" });
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
});

test("N3: rounding up keeps tiny cache-read requests from charging 0", () => {
  const one = { usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cache_read_tokens: 1 }, usageKnown: true, usageScope: "run" };
  assert.equal(runScopedUsageSource(one, { cacheReadWeight: 0.1 }), 1);
  assert.equal(runScopedUsageSource(one, { cacheReadWeight: 0.4 }), 1);
  const resolved = resolveChatParams(gapMax, chat({ model: "gap-max", reasoning_effort: "Medium" }));
  assert.deepEqual(resolved, [{ id: "reasoning_effort", value: "medium" }], "case-insensitive exact match");
});

test("N3: global QUOTA_CACHE_READ_WEIGHT is wired into charging (e2e)", { timeout: 20_000 }, async () => {
  // Fake usage: input 11 + output 2 + cache read 3 = 16; weight 0.1 → 13 + 0.3 → ceil 14.
  const gateway = await startFakeGateway({ QUOTA_CACHE_READ_WEIGHT: "0.1" }, { keyPolicy: { quota_tokens: 100_000 } });
  try {
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).usage.total_tokens, 16);
    let tokens;
    for (let i = 0; i < 50; i += 1) {
      const usage = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage`, { headers: { authorization: "Bearer it-admin-key" } });
      tokens = (await usage.json()).current.tokens;
      if (tokens === 14) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(tokens, 14);
  } finally {
    await gateway.stop();
  }
});

test("N3: admin rejects negative and non-numeric weights", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  const admin = (method, path, body) =>
    fetch(`${gateway.baseUrl}/admin/api/keys${path}`, {
      method,
      headers: { authorization: "Bearer it-admin-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const bad of [-0.1, -1, true, [0.5], { v: 1 }, 1.0001]) {
      assert.equal((await admin("PATCH", "/it-key", { quota_cache_read_weight: bad })).status, 400, JSON.stringify(bad));
      assert.equal((await admin("POST", "", { name: "x", quota_cache_read_weight: bad })).status, 400, `POST ${JSON.stringify(bad)}`);
    }
    for (const ok of [0, 1]) {
      const res = await admin("PATCH", "/it-key", { quota_cache_read_weight: ok });
      assert.equal((await res.json()).quota_cache_read_weight, ok);
    }
  } finally {
    await gateway.stop();
  }
});

test("N4: integer TOML keys reject decimals at startup; weight rejects booleans", () => {
  const root = mkdtempSync(join(tmpdir(), "int-toml-"));
  mkdirSync(join(root, "data", "config"), { recursive: true });
  const toml = join(root, "data", "config", "gateway.toml");
  const base = ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"'];
  const load = (line) => {
    writeFileSync(toml, [...base, line, ""].join("\n"));
    return loadConfig({ DATA_DIR: "data" }, root);
  };
  assert.throws(() => load("auth_failure_limit = 0.5"), /auth_failure_limit must be an integer/);
  assert.throws(() => load("auth_failure_limit = 5.0"), /auth_failure_limit must be an integer/);
  assert.throws(() => load("sse_keepalive_ms = 1500.5"), /sse_keepalive_ms must be an integer/);
  assert.throws(() => load("park_timeout_ms = 6000.9"), /park_timeout_ms must be an integer/);
  assert.throws(() => load("quota_cache_read_weight = true"), /quota_cache_read_weight/);
  assert.equal(load("auth_failure_limit = 5").authFailureLimit ?? 5, 5);
  assert.equal(load("quota_cache_read_weight = 0.1").quotaCacheReadWeight, 0.1);
  assert.equal(load('quota_cache_read_weight = "0.3"').quotaCacheReadWeight, 0.3);
});

test("N5: upgrading rewrites old request-log input_tokens once, so aggregates use one semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-migrate-"));
  let db = openDb(dir);
  const now = new Date().toISOString();
  insertApiKey(db, { id: "k", name: "k", key_prefix: "k", key_digest: "d-k", created_at: now, updated_at: now });
  const insertSql =
    `INSERT INTO request_logs (id, api_key_id, path, model, stream, http_status, duration_ms, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, created_at)
     VALUES (?, 'k', '/v1/chat/completions', 'm', 0, 200, 1, ?, 2, ?, ?, ?, ?)`;
  const insert = { run: (...args) => db.prepare(insertSql).run(...args) };
  insert.run("old", 100, 157, 50, 5, now); // pre-v11: uncached input
  insert.run("unknown", null, null, null, null, now);
  db.exec("PRAGMA user_version = 10");
  db.close();
  db = openDb(dir);
  const input = (id) => db.prepare("SELECT input_tokens FROM request_logs WHERE id = ?").get(id).input_tokens;
  assert.equal(input("old"), 155);
  assert.equal(input("unknown"), null);
  insert.run("new", 155, 157, 50, 5, now); // v11 row, already cache-inclusive
  db.close();
  db = openDb(dir); // second open: no double rewrite
  try {
    assert.equal(input("old"), 155);
    assert.equal(input("new"), 155);
    assert.equal(tokenStatsByKey(db).find((row) => row.api_key_id === "k").input_tokens, 310);
  } finally {
    db.close();
  }
});
