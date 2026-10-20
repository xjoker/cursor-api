// Merged from Elliot's PR #44 review (evidence/probes/zz-killers.test.mjs, 2659e75): tests that kill
// mutants which survived the original suite. Adapted to the r1 store API (client user scope).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearHistory, configureHistoryResume, hashHistory, historyEntryCount, rememberHistory } from "../dist/history-resume.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
const H = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const ADMIN = { authorization: "Bearer it-admin-key", "content-type": "application/json" };
const u = (c) => ({ role: "user", content: c }), a = (c) => ({ role: "assistant", content: c });
const chat = async (gw, messages, extra = {}) => { const r = await fetch(`${gw.baseUrl}/v1/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "fake-model", messages, ...extra }) }); const t = await r.text(); return { status: r.status, body: r.status === 200 ? JSON.parse(t) : t }; };
const content = (r) => r.body.choices[0].message.content;
const matches = (gw) => (gw.output().match(/history matched a previous agent/g) ?? []).length;

test("K-unit: hash sensitive to role / tool_call_id / tool_calls / images; disabled store stays empty", () => {
  const base = [u("q"), { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "f", arguments: "{}" }] }, { role: "tool", tool_call_id: "c1", content: "r" }];
  assert.notEqual(hashHistory([u("X")]), hashHistory([{ role: "system", content: "X" }]));
  assert.notEqual(hashHistory(base), hashHistory([base[0], base[1], { ...base[2], tool_call_id: "c2" }]));
  assert.notEqual(hashHistory(base), hashHistory([base[0], { ...base[1], tool_calls: [{ id: "c1", name: "g", arguments: "{}" }] }, base[2]]));
  assert.notEqual(hashHistory([{ ...u("q"), images: [{ url: "https://a/1.png" }] }]), hashHistory([{ ...u("q"), images: [{ url: "https://a/2.png" }] }]));
  clearHistory(); configureHistoryResume({ enabled: false });
  rememberHistory("k", undefined, "h", { agentId: "a" });
  assert.equal(historyEntryCount(), 0);
});

test("K-e2e: stop-sequence and JSON-mode replies not remembered; explicit conversation_id turns not remembered", { timeout: 30_000 }, async () => {
  const gw = await startFakeGateway({ HISTORY_RESUME: "true", ENFORCE_OUTPUT_LIMITS: "true" });
  try {
    const s = await chat(gw, [u("hello")], { stop: ["NG"] });
    assert.equal(content(s), "PO");
    await chat(gw, [u("hello"), a("PO"), u("ECHO_AGENT")]);
    assert.equal(matches(gw), 0, "stop-sequence reply must not be remembered");
    const j = await chat(gw, [u("hello json")], { response_format: { type: "json_object" } });
    await chat(gw, [u("hello json"), a(content(j)), u("ECHO_AGENT")]);
    assert.equal(matches(gw), 0, "json-mode reply must not be remembered");
    const c = await chat(gw, [u("conv")], { conversation_id: "c-1" });
    await chat(gw, [u("conv"), a(content(c)), u("ECHO_AGENT")]);
    assert.equal(matches(gw), 0, "explicit conversation_id turn must not feed the history store");
  } finally { await gw.stop(); }
});

test("K-e2e: resumed agent that the SDK resolves to max is rejected when max is now disallowed", { timeout: 30_000 }, async () => {
  const gw = await startFakeGateway({ HISTORY_RESUME: "true", FAKE_SDK_FORCE_MAX: "agent" });
  try {
    const t1 = await chat(gw, [u("hello")]);
    assert.equal(t1.status, 200);
    await fetch(`${gw.baseUrl}/admin/api/keys/it-key`, { method: "PATCH", headers: ADMIN, body: JSON.stringify({ allow_max_mode: false }) });
    const t2 = await chat(gw, [u("hello"), a(content(t1)), u("ECHO_MAX")]);
    assert.equal(matches(gw), 1);
    assert.equal(t2.status, 403, JSON.stringify(t2.body).slice(0, 200));
  } finally { await gw.stop(); }
});

test("K-e2e: pool owner is kept (no legacy full-transcript replay)", { timeout: 30_000 }, async () => {
  const gw = await startFakeGateway({ HISTORY_RESUME: "true", CURSOR_API_KEYS: "good-key-2,good-key-3" });
  try {
    for (let i = 0; i < 3; i++) {
      const k1 = content(await chat(gw, [u(`ECHO_KEY ${i}`)]));
      const k2 = content(await chat(gw, [u(`ECHO_KEY ${i}`), a(k1), u("ECHO_KEY")]));
      assert.equal(k2, k1);
    }
    assert.doesNotMatch(gw.output(), /replaying legacy conversation/);
    assert.equal(matches(gw), 3);
  } finally { await gw.stop(); }
});
