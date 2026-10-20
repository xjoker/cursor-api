// #44 review round 1 (Elliot, 2659e75): history-hash reuse is single use across all paths with a
// per-agent lock (#1), reused turns are estimated like the full transcript (#2), records are
// scoped by the client's `user` and purged with the key. Offline (fake SDK).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const HEADERS = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const ADMIN = { authorization: "Bearer it-admin-key", "content-type": "application/json" };
const TOOLS = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });
const matches = (gateway) => (gateway.output().match(/history matched a previous agent/g) ?? []).length;

async function chat(gateway, messages, extra = {}) {
  const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", messages, ...extra }) });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? JSON.parse(text) : text };
}
const content = (reply) => reply.body.choices[0].message.content;

async function responses(gateway, body) {
  const res = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "fake-model", ...body }) });
  const text = await res.text();
  const json = res.status === 200 ? JSON.parse(text) : text;
  return { status: res.status, body: json, text: res.status === 200 ? json.output.find((item) => item.type === "message").content[0].text : undefined };
}

const fullHistory = (agent) => [
  { role: "user", content: "ECHO_AGENT" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: agent }] },
  { role: "user", content: "ECHO_AGENT" },
];

test("#1: a previous_response_id continuation invalidates the history record of that agent", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true" });
  try {
    const first = await responses(gateway, { input: "ECHO_AGENT" });
    const agent = first.text;
    const continued = await responses(gateway, { input: "ECHO_AGENT", previous_response_id: first.body.id });
    assert.equal(continued.text, agent, "previous_response_id resumes the agent");
    const viaHash = await responses(gateway, { store: false, input: fullHistory(agent) });
    assert.notEqual(viaHash.text, agent, "the agent moved on: the same history must get a new agent");
    assert.equal(matches(gateway), 0);
  } finally {
    await gateway.stop();
  }
});

test("#1: concurrent previous_response_id + history reuse never run on the same agent", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true", FAKE_SDK_DELAY_MS: "400" });
  try {
    const first = await responses(gateway, { input: "ECHO_AGENT" });
    const agent = first.text;
    // History reuse claims the agent first (send is slow); the previous_response_id request then
    // finds the agent busy instead of sending on it concurrently.
    const hashPending = responses(gateway, { store: false, input: fullHistory(agent) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const byPrev = await responses(gateway, { input: "ECHO_AGENT", previous_response_id: first.body.id });
    const byHash = await hashPending;
    assert.equal(byHash.text, agent, "history reuse got the agent");
    assert.equal(byPrev.status, 409, `previous_response_id on a busy agent: ${String(byPrev.status)}`);
    assert.match(String(byPrev.body), /conversation_busy/);
    const onAgent = [byPrev, byHash].filter((reply) => reply.status === 200 && reply.text === agent);
    assert.ok(onAgent.length <= 1, `both requests ran on ${agent}: ${JSON.stringify([byPrev.status, byHash.status])}`);
    assert.equal(byHash.status, 200, "history reuse falls back to a new agent, never fails");
  } finally {
    await gateway.stop();
  }
});

test("#1: the same history sent twice at once resumes the agent at most once", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true", FAKE_SDK_DELAY_MS: "300" });
  try {
    const agent = content(await chat(gateway, [u("ECHO_AGENT")]));
    const history = [u("ECHO_AGENT"), a(agent), u("ECHO_AGENT")];
    const replies = await Promise.all([chat(gateway, history), chat(gateway, history), chat(gateway, history)]);
    for (const reply of replies) assert.equal(reply.status, 200);
    assert.equal(replies.filter((reply) => content(reply) === agent).length, 1, "single use");
    assert.equal(new Set(replies.map(content)).size, 3, "the others got new agents");
  } finally {
    await gateway.stop();
  }
});

test("#2: a reused turn is estimated like the full transcript (same charge as HISTORY_RESUME=false)", { timeout: 60_000 }, async () => {
  const charges = {};
  for (const flag of ["true", "false"]) {
    const gateway = await startFakeGateway({ HISTORY_RESUME: flag, FAKE_SDK_NO_USAGE_ON_CANCEL: "1", PARK_TIMEOUT_MS: "5000" }, { keyPolicy: { quota_tokens: 1_000_000 } });
    try {
      const big = "x".repeat(40_000);
      const reply = content(await chat(gateway, [u(big)]));
      await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage/reset`, { method: "POST", headers: ADMIN });
      // The suspended tool round is precharged on the estimate (no upstream usage yet).
      const parked = await chat(gateway, [u(big), a(reply), u("CALL_TOOL<<lookup|{}>>")], { tools: TOOLS });
      assert.equal(parked.body.choices[0].finish_reason, "tool_calls");
      const res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/usage`, { headers: ADMIN });
      charges[flag] = (await res.json()).current.tokens;
      assert.equal(matches(gateway), flag === "true" ? 1 : 0);
    } finally {
      await gateway.stop();
    }
  }
  assert.ok(charges.false >= 10_000, JSON.stringify(charges));
  assert.equal(charges.true, charges.false, JSON.stringify(charges));
});

test("records are scoped by the client's `user` and purged when the key is disabled or deleted", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true" });
  try {
    const agent = content(await chat(gateway, [u("ECHO_AGENT")], { user: "alice" }));
    assert.notEqual(content(await chat(gateway, [u("ECHO_AGENT"), a(agent), u("ECHO_AGENT")], { user: "bob" })), agent, "other user: miss");
    assert.equal(content(await chat(gateway, [u("ECHO_AGENT"), a(agent), u("ECHO_AGENT")], { user: "alice" })), agent, "same user: hit");

    const again = content(await chat(gateway, [u("ECHO_AGENT 2")]));
    let res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/disable`, { method: "POST", headers: ADMIN });
    assert.equal(res.status, 200);
    res = await fetch(`${gateway.baseUrl}/admin/api/keys/it-key/enable`, { method: "POST", headers: ADMIN });
    assert.equal(res.status, 200);
    assert.notEqual(content(await chat(gateway, [u("ECHO_AGENT 2"), a(again), u("ECHO_AGENT")])), again, "disable dropped the record");
  } finally {
    await gateway.stop();
  }
});
