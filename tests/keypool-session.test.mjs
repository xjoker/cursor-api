import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../dist/db.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const auth = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };

async function post(gateway, path, body, headers = auth) {
  return fetch(`${gateway.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

test("old conversation databases gain a nullable Cursor key fingerprint without losing mappings", (context) => {
  const root = makeTempDir(context, "cursor-api-key-owner-migration-");
  const path = join(root, "cursor-api.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE conversations (
      api_key_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_key_id, conversation_id)
    );
    INSERT INTO conversations VALUES ('client', 'thread', 'agent-1', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const db = openDb(root);
  const columns = db.prepare("PRAGMA table_info(conversations)").all().map((row) => row.name);
  assert.ok(columns.includes("cursor_key_id"));
  const row = db.prepare("SELECT agent_id, cursor_key_id FROM conversations WHERE conversation_id = 'thread'").get();
  assert.equal(row.agent_id, "agent-1");
  assert.equal(row.cursor_key_id, null);
  db.close();

  const reopened = openDb(root);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM conversations").get().n, 1);
  reopened.close();
});

test("model validation and execution use one pooled key for Chat, Responses, and Messages", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ CURSOR_API_KEY: "model-a-key", CURSOR_API_KEYS: "model-b-key" });
  const anthropicHeaders = { "x-api-key": CLIENT_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  try {
    const chat = await post(gateway, "/v1/chat/completions", {
      model: "fake-model-a", messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(chat.status, 200, await chat.clone().text());

    const responses = await post(gateway, "/v1/responses", { model: "fake-model-a", input: "hi" });
    assert.equal(responses.status, 200, await responses.clone().text());

    const messages = await post(gateway, "/v1/messages", {
      model: "fake-model-b", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
    }, anthropicHeaders);
    assert.equal(messages.status, 200, await messages.clone().text());
  } finally {
    await gateway.stop();
  }
});

test("streaming requests reject an unknown model before starting SSE for all protocols", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({});
  const cases = [
    ["/v1/chat/completions", { model: "missing-model", stream: true, messages: [{ role: "user", content: "hi" }] }, auth],
    ["/v1/responses", { model: "missing-model", stream: true, input: "hi" }, auth],
    ["/v1/messages", { model: "missing-model", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": CLIENT_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }],
  ];
  try {
    for (const [path, body, headers] of cases) {
      const response = await post(gateway, path, body, headers);
      assert.equal(response.status, 404, `${path}: ${await response.clone().text()}`);
      assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const payload = await response.json();
      assert.equal(payload.error?.code ?? payload.error?.type, "model_not_found");
    }
  } finally {
    await gateway.stop();
  }
});

test("incremental response resumes with its owning Cursor key and preserves the agent", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ CURSOR_API_KEY: "owner-a", CURSOR_API_KEYS: "owner-b,owner-c" });
  try {
    const first = await post(gateway, "/v1/responses", { model: "fake-model", input: "ECHO_AGENT" });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    const firstAgent = firstBody.output.find((item) => item.type === "message")?.content?.[0]?.text;

    const second = await post(gateway, "/v1/responses", {
      model: "fake-model", previous_response_id: firstBody.id, input: "ECHO_AGENT",
    });
    assert.equal(second.status, 200, await second.clone().text());
    const secondBody = await second.json();
    const secondAgent = secondBody.output.find((item) => item.type === "message")?.content?.[0]?.text;
    assert.equal(secondAgent, firstAgent);
    assert.doesNotMatch(gateway.output(), /conversation resume failed, starting new/);
  } finally {
    await gateway.stop();
  }
});

test("parked tool continuation is counted as one pooled run per HTTP turn", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ CURSOR_API_KEY: "owner-a", CURSOR_API_KEYS: "owner-b" });
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
  try {
    const firstMessages = [{ role: "user", content: "CALL_TOOL" }];
    const first = await post(gateway, "/v1/chat/completions", {
      model: "fake-model", conversation_id: "pool-count", tools, messages: firstMessages,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    const call = firstBody.choices[0].message.tool_calls[0];
    const second = await post(gateway, "/v1/chat/completions", {
      model: "fake-model", conversation_id: "pool-count", tools,
      messages: [...firstMessages, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "42" }],
    });
    assert.equal(second.status, 200, await second.clone().text());

    const status = await fetch(`${gateway.baseUrl}/admin/api/cursor-keys`, { headers: { authorization: "Bearer it-admin-key" } });
    const { keys } = await status.json();
    assert.equal(keys.reduce((sum, key) => sum + key.requests, 0), 2);
    assert.ok(keys.every((key) => key.active_requests === 0));
  } finally {
    await gateway.stop();
  }
});

test("streaming invalid tool results return 400 before starting SSE", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
  const messages = [{ role: "user", content: "CALL_TOOL" }];
  try {
    const first = await post(gateway, "/v1/chat/completions", {
      model: "fake-model", conversation_id: "bad-tool-result", tools, messages,
    });
    assert.equal(first.status, 200);
    const call = (await first.json()).choices[0].message.tool_calls[0];
    const invalid = await post(gateway, "/v1/chat/completions", {
      model: "fake-model", conversation_id: "bad-tool-result", tools, stream: true,
      messages: [...messages, { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: "unknown-call", content: "42" }],
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get("content-type"), /application\/json/);
    await invalid.text();
  } finally { await gateway.stop(); }
});
