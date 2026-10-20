import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const chat = (gateway, body) => fetch(`${gateway.baseUrl}/v1/chat/completions`, {
  method: "POST", headers, body: JSON.stringify({ model: "fake-model", ...body }),
});

test("a different explicit conversation cannot borrow a parked agent's concurrency slot", async () => {
  const gateway = await startFakeGateway({}, { keyPolicy: { max_concurrent: 1 } });
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];
  const user = { role: "user", content: "CALL_TOOL" };
  try {
    const first = await chat(gateway, { conversation_id: "park-A", tools, messages: [user] });
    assert.equal(first.status, 200);
    const parked = await first.json();
    const message = parked.choices[0].message;
    assert.equal(parked.choices[0].finish_reason, "tool_calls");
    const messages = [user, message, { role: "tool", tool_call_id: message.tool_calls[0].id, content: "sunny" }];
    const other = await chat(gateway, { conversation_id: "replay-B", tools, messages });
    assert.equal(other.status, 429, await other.clone().text());
    assert.equal((await other.json()).error.code, "concurrency_limit_exceeded");
    const own = await chat(gateway, { conversation_id: "park-A", tools, messages });
    assert.equal(own.status, 200, await own.clone().text());
    assert.match((await own.json()).choices[0].message.content, /sunny/);
  } finally {
    await gateway.stop();
  }
});

test("a dispatched max-mode rejection invalidates every conversation alias of that agent", async (context) => {
  const ledger = join(makeTempDir(context, "session-policy-ledger-"), "events.jsonl");
  const gateway = await startFakeGateway({ ALLOW_MAX_MODE: "false", FAKE_SDK_FORCE_MAX: "run-resumed", FAKE_SDK_LEDGER: ledger });
  const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"), { timeout: 5000 });
  const rows = () => db.prepare("SELECT * FROM conversations WHERE api_key_id = ?").all("it-key");
  try {
    const first = await chat(gateway, { conversation_id: "C", messages: [{ role: "user", content: "hello" }] });
    assert.equal(first.status, 200);
    const agentId = rows()[0].agent_id;
    db.prepare("INSERT INTO conversations SELECT api_key_id, ?, agent_id, cursor_key_id, updated_at FROM conversations WHERE api_key_id = ? AND conversation_id = ?").run("alias-C", "it-key", "C");
    const rejected = await chat(gateway, { conversation_id: "C", messages: [{ role: "user", content: "rejected input" }] });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "max_mode_not_allowed");
    const next = await chat(gateway, { conversation_id: "alias-C", messages: [{ role: "user", content: "clean input" }] });
    assert.equal(next.status, 200, await next.clone().text());
    assert.ok(rows().every((row) => row.agent_id !== agentId), "the rejected agent has no remaining aliases");
    const events = readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.event === "resume" && event.agentId === agentId).length, 1, "rejected agent is never resumed again");
    assert.equal(events.filter((event) => event.event === "cancel").length, 1);
  } finally {
    db.close();
    await gateway.stop();
  }
});
