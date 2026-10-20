// Max-mode guard, review round 4 (final): canonical param values (C1), no replay after a
// send-stage block (C2), max_mode logged for send-stage blocks (C3), and the two visible
// mutants (C5): streaming create-stage 403 must stay JSON, no text before the run.model check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { configureMaxMode, maxOnlyParamValues, resolveCatalogModelSelection, resolveChatParams } from "../dist/cursor.js";
import { parseChatCompletionsRequest } from "../dist/openai.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const catalog = {
  id: "fake-max",
  parameters: [
    { id: "context", values: [{ value: "200k", displayName: "200k context" }, { value: "1m", displayName: "1m context" }] },
    { id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
  ],
  variants: [
    { displayName: "Low", params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "low" }] },
    { displayName: "High", isDefault: true, params: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "high" }] },
    { displayName: "1M", isMaxMode: true, params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }] },
  ],
};
const chat = (body) => parseChatCompletionsRequest({ model: "fake-max", messages: [{ role: "user", content: "x" }], ...body });
const paramsOf = (selection) => Object.fromEntries((selection.params ?? []).map((p) => [p.id, p.value]));
const is403 = (error) => error.httpStatus === 403 && error.code === "max_mode_not_allowed";

test("C1: params are forwarded as the catalog's canonical value (case variants, display names)", () => {
  for (const value of ["1M", "1m", " 1m".trim(), "1m context", "1M CONTEXT"]) {
    assert.deepEqual(resolveChatParams(catalog, chat({ params: [{ id: "context", value }] })).find((p) => p.id === "context"), { id: "context", value: "1m" }, value);
  }
  assert.deepEqual(resolveChatParams(catalog, chat({ params: [{ id: "context", value: "200K" }] })).find((p) => p.id === "context").value, "200k");
  configureMaxMode({ allowMaxMode: false });
  try {
    for (const value of ["1M", "1m context", "1M Context"]) {
      assert.throws(() => resolveCatalogModelSelection([catalog], chat({ params: [{ id: "context", value }] })), is403, value);
      assert.throws(() => resolveCatalogModelSelection([catalog], chat({ params: [{ id: "context", value }], reasoning_effort: "low" })), is403, `${value}+low`);
    }
  } finally {
    configureMaxMode({ allowMaxMode: true });
  }
  const allowed = resolveCatalogModelSelection([catalog], chat({ params: [{ id: "context", value: "1M" }] }));
  assert.deepEqual(paramsOf(allowed), { context: "1m", reasoning_effort: "high" });
  assert.equal(allowed.maxMode, true, "canonical value lets the SDK rule see max mode");
  // Second line of defence: the max-only check itself is case-insensitive.
  assert.equal(maxOnlyParamValues(catalog, [{ id: "context", value: "1M" }]).length, 1);
});

function client(gateway) {
  const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
  const post = (path, body) => fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return {
    chat: (body) => post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], ...body }),
    responses: (body) => post("/v1/responses", body),
    logs: async () => (await (await fetch(`${gateway.baseUrl}/admin/api/logs`, { headers: { authorization: "Bearer it-admin-key" } })).json()).logs,
  };
}
const readLedger = (file) => {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const ledgerFile = () => join(makeTempDir({ after }, "fake-ledger-"), "ledger.jsonl");

test("C1 e2e: params context=1M / '1m context' never reach upstream when max mode is off", { timeout: 20_000 }, async () => {
  const file = ledgerFile();
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_LEDGER: file });
  try {
    const api = client(gateway);
    for (const value of ["1M", "1m"]) {
      const res = await api.chat({ model: "fake-max", params: [{ id: "context", value }] });
      assert.equal(res.status, 403, value);
    }
    // The fake catalog has no value display names, so a display name is simply invalid here
    // (display-name canonicalisation is covered by the unit test above).
    assert.equal((await api.chat({ model: "fake-max", params: [{ id: "context", value: "1m context" }] })).status, 400);
    assert.equal(readLedger(file).filter((e) => e.event === "dispatch").length, 0, "nothing sent upstream");
  } finally {
    await gateway.stop();
  }
});

test("C2/C3: a send-stage block on the resume path is not replayed and is logged as max_mode=1", { timeout: 20_000 }, async () => {
  const file = ledgerFile();
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "run-resumed", FAKE_SDK_LEDGER: file });
  try {
    const api = client(gateway);
    let res = await api.chat({ model: "fake-model", conversation_id: "c2", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200, await res.clone().text());
    const before = readLedger(file).length;
    res = await api.chat({
      model: "fake-model",
      conversation_id: "c2",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "PONG" }, { role: "user", content: "again" }],
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    const events = readLedger(file).slice(before);
    const dispatches = events.filter((e) => e.event === "dispatch");
    assert.equal(dispatches.length, 1, `max request sent once, not replayed: ${JSON.stringify(events)}`);
    assert.equal(dispatches[0].maxMode, true);
    assert.equal(events.filter((e) => e.event === "cancel").length, 1);
    assert.equal(events.filter((e) => e.event === "create").length, 0, "no replay agent");
    assert.doesNotMatch(gateway.output(), /conversation resume failed, replaying full transcript/);
    const rows = (await api.logs()).filter((log) => log.error_code === "max_mode_not_allowed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].max_mode, 1, "the cancelled max run is visible in the request log");
  } finally {
    await gateway.stop();
  }
});

test("C5: streaming create-stage block is a 403 JSON response, not an SSE 200", { timeout: 20_000 }, async () => {
  const file = ledgerFile();
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "agent", FAKE_SDK_LEDGER: file });
  try {
    const api = client(gateway);
    for (const [name, send] of Object.entries({
      chat: () => api.chat({ model: "fake-model", stream: true }),
      responses: () => api.responses({ model: "fake-model", input: "hi", stream: true }),
    })) {
      const res = await send();
      assert.equal(res.status, 403, name);
      assert.match(res.headers.get("content-type") ?? "", /json/, `${name}: JSON, not SSE`);
      assert.equal((await res.json()).error.code, "max_mode_not_allowed");
    }
    const events = readLedger(file);
    assert.equal(events.filter((e) => e.event === "dispatch").length, 0);
    assert.equal(events.filter((e) => e.event === "dispose").length, events.filter((e) => e.event === "create").length, "every agent released");
  } finally {
    await gateway.stop();
  }
});

test("C5: no model text streams before the run.model check, even when the SDK emits it early", { timeout: 20_000 }, async () => {
  const file = ledgerFile();
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "run", FAKE_SDK_EARLY_DELTA: "1", FAKE_SDK_LEDGER: file });
  try {
    const res = await client(gateway).chat({ model: "fake-model", stream: true });
    const text = await res.text();
    const frames = parseSse(text);
    assert.ok(frames.some((f) => f.data?.error?.code === "max_mode_not_allowed"), text);
    assert.doesNotMatch(text, /EARLY_LEAK|PONG/, "held deltas are discarded");
    const events = readLedger(file);
    assert.equal(events.filter((e) => e.event === "cancel").length, 1, "run cancelled");
    assert.ok(events.some((e) => e.event === "dispose"), "agent released");
  } finally {
    await gateway.stop();
  }
  // Allowed: the early delta does reach the client (the fixture really emits it).
  const open = await startFakeGateway({ FAKE_SDK_EARLY_DELTA: "1" });
  try {
    const res = await client(open).chat({ model: "fake-model", stream: true });
    assert.match(await res.text(), /EARLY_LEAK/);
  } finally {
    await open.stop();
  }
});
