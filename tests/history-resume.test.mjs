// SAF-95 PR C: without a conversation_id, a history-hash match resumes the previous agent and
// sends only the new user message. Offline (fake SDK).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearHistory, configureHistoryResume, forgetAgent, forgetKey, hashHistory, HISTORY_TTL_MS, MAX_HISTORY_ENTRIES_PER_KEY, historyEntryCount, rememberHistory, sweepHistory, takeHistory } from "../dist/history-resume.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

test("hashHistory: stable, trims assistant text only, sensitive to everything else", () => {
  const base = [{ role: "system", content: "S" }, user("hi"), assistant("PONG")];
  assert.equal(hashHistory(base), hashHistory([{ role: "system", content: "S" }, user("hi"), assistant("  PONG\n")]));
  assert.notEqual(hashHistory(base), hashHistory([{ role: "system", content: "S2" }, user("hi"), assistant("PONG")]));
  assert.notEqual(hashHistory(base), hashHistory([{ role: "system", content: "S" }, user("hi "), assistant("PONG")]));
  assert.notEqual(hashHistory(base), hashHistory([{ role: "system", content: "S" }, user("hi"), assistant("PONG!")]));
  assert.match(hashHistory(base), /^h1:[0-9a-f]{64}$/);
});

test("history store: single-use, per client key and user, expiring, bounded per key, switchable", () => {
  clearHistory();
  configureHistoryResume({ enabled: true });
  try {
    rememberHistory("k1", undefined, "h", { agentId: "a1", cursorKeyId: "c1" }, 1000);
    assert.equal(takeHistory("k2", undefined, "h", 1001), undefined);
    assert.equal(takeHistory("k1", "alice", "h", 1001), undefined, "scoped by the client's user field");
    assert.deepEqual(takeHistory("k1", undefined, "h", 1001), { agentId: "a1", cursorKeyId: "c1" });
    assert.equal(takeHistory("k1", undefined, "h", 1002), undefined, "single use");
    rememberHistory("k1", undefined, "h", { agentId: "a1" }, 1000);
    assert.equal(takeHistory("k1", undefined, "h", 1000 + HISTORY_TTL_MS), undefined, "expired");
    for (let index = 0; index <= MAX_HISTORY_ENTRIES_PER_KEY; index += 1) rememberHistory("k1", undefined, `h${String(index)}`, { agentId: `a${String(index)}` }, 5000);
    assert.equal(historyEntryCount("k1"), MAX_HISTORY_ENTRIES_PER_KEY);
    assert.equal(takeHistory("k1", undefined, "h0", 5001), undefined, "oldest dropped");
    configureHistoryResume({ enabled: false });
    assert.equal(historyEntryCount(), 0);
    rememberHistory("k1", undefined, "x", { agentId: "a" });
    assert.equal(historyEntryCount(), 0, "nothing stored while disabled");
  } finally {
    clearHistory();
  }
});

test("history store: one record per agent state; forgetAgent / forgetKey; per-key cap; expired entries purged", () => {
  clearHistory();
  configureHistoryResume({ enabled: true });
  try {
    rememberHistory("k1", undefined, "h1", { agentId: "A" }, 1000);
    rememberHistory("k1", undefined, "h2", { agentId: "A" }, 1000);
    assert.equal(takeHistory("k1", undefined, "h1", 1001), undefined, "a newer turn of the agent replaces its older record");
    assert.equal(takeHistory("k1", undefined, "h2", 1001)?.agentId, "A");
    rememberHistory("k1", undefined, "h3", { agentId: "B" }, 1000);
    forgetAgent("B");
    assert.equal(takeHistory("k1", undefined, "h3", 1001), undefined, "forgetAgent drops the record");

    // Per key: one key filling its quota never evicts another key's records.
    rememberHistory("victim", undefined, "keep", { agentId: "V" }, 2000);
    for (let index = 0; index < MAX_HISTORY_ENTRIES_PER_KEY + 50; index += 1) rememberHistory("noisy", undefined, `n${String(index)}`, { agentId: `N${String(index)}` }, 2000);
    assert.equal(historyEntryCount("noisy"), MAX_HISTORY_ENTRIES_PER_KEY);
    assert.equal(historyEntryCount("victim"), 1);
    forgetKey("noisy");
    assert.equal(historyEntryCount("noisy"), 0);

    // Expired entries are purged on a later write (sweep), not just when looked up.
    rememberHistory("old", undefined, "o1", { agentId: "O1" }, 3000);
    rememberHistory("old", undefined, "o2", { agentId: "O2" }, 3000);
    sweepHistory(3000 + HISTORY_TTL_MS, true);
    assert.equal(historyEntryCount("old"), 0);
    assert.equal(historyEntryCount("victim"), 0, "victim expired too");
  } finally {
    configureHistoryResume({ enabled: false });
    clearHistory();
  }
});

async function chat(gateway, messages, extra = {}) {
  const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "fake-model", messages, ...extra }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  return body.choices[0];
}

test("e2e chat: matching history resumes the agent and sends only the new message", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true" });
  try {
    const system = { role: "system", content: "You are terse." };
    const first = (await chat(gateway, [system, user("ECHO_AGENT")])).message.content;
    assert.match(first, /^agent-\d+$/);

    // Turn 2: same agent.
    const history = [system, user("ECHO_AGENT"), assistant(first)];
    assert.equal((await chat(gateway, [...history, user("ECHO_AGENT again")])).message.content, first);

    // Turn 3: the upstream prompt is just the new message (no transcript).
    const history3 = [...history, user("ECHO_AGENT again"), assistant(`${first}\n`)];
    assert.equal((await chat(gateway, [...history3, user("ECHO_PROMPT_TAIL")])).message.content, "ECHO_PROMPT_TAIL");

    // Regenerating turn 3 (same history, consumed): fresh agent with the full transcript.
    const regenerated = (await chat(gateway, [...history3, user("ECHO_PROMPT_TAIL")])).message.content;
    assert.notEqual(regenerated, "ECHO_PROMPT_TAIL");
    assert.match(regenerated, /You are terse\.[\s\S]*ECHO_AGENT again[\s\S]*ECHO_PROMPT_TAIL/);

    // Edited history (assistant text changed): miss → fresh agent.
    const other = (await chat(gateway, [system, user("ECHO_AGENT"), assistant(`${first} edited`), user("ECHO_AGENT")])).message.content;
    assert.notEqual(other, first);

    // Explicit conversation_id keeps the existing conversation mapping path (no history lookup).
    const a = (await chat(gateway, [user("ECHO_AGENT")])).message.content;
    const b = (await chat(gateway, [user("ECHO_AGENT"), assistant(a), user("ECHO_AGENT")], { conversation_id: "conv-x" })).message.content;
    assert.notEqual(b, a);
  } finally {
    await gateway.stop();
  }
});

test("e2e: truncated replies are not remembered; history_resume off (default and explicit false) never resumes", { timeout: 30_000 }, async () => {
  const limited = await startFakeGateway({ ENFORCE_OUTPUT_LIMITS: "true", HISTORY_RESUME: "true" });
  try {
    const cut = await chat(limited, [user("ECHO_AGENT")], { max_tokens: 1 });
    assert.equal(cut.finish_reason, "length");
    const next = (await chat(limited, [user("ECHO_AGENT"), assistant(cut.message.content), user("ECHO_PROMPT_TAIL")])).message.content;
    assert.notEqual(next, "ECHO_PROMPT_TAIL");
  } finally {
    await limited.stop();
  }

  for (const env of [{}, { HISTORY_RESUME: "false" }]) {
    const off = await startFakeGateway(env);
    try {
      const first = (await chat(off, [user("ECHO_AGENT")])).message.content;
      assert.notEqual((await chat(off, [user("ECHO_AGENT"), assistant(first), user("ECHO_AGENT")])).message.content, first, JSON.stringify(env));
      assert.doesNotMatch(off.output(), /history matched a previous agent/);
    } finally {
      await off.stop();
    }
  }
});

test("e2e: a failed resume falls back to the full transcript", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ FAKE_SDK_FAIL_RESUME: "1", HISTORY_RESUME: "true" });
  try {
    const first = (await chat(gateway, [user("ECHO_AGENT")])).message.content;
    const reply = (await chat(gateway, [user("ECHO_AGENT"), assistant(first), user("ECHO_PROMPT_TAIL")])).message.content;
    assert.match(reply, /ECHO_AGENT[\s\S]*ECHO_PROMPT_TAIL/);
    assert.match(gateway.output(), /history matched a previous agent/);
    assert.match(gateway.output(), /conversation resume failed, replaying full transcript/);
  } finally {
    await gateway.stop();
  }
});

test("e2e: stateless Responses / Messages clients resume by history too", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ HISTORY_RESUME: "true" });
  try {
    let res = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "fake-model", input: "ECHO_AGENT", store: false }) });
    const first = (await res.json()).output.find((item) => item.type === "message").content[0].text;
    res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fake-model",
        store: false,
        input: [
          { role: "user", content: "ECHO_AGENT" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: first }] },
          { role: "user", content: "ECHO_AGENT" },
        ],
      }),
    });
    assert.equal((await res.json()).output.find((item) => item.type === "message").content[0].text, first);

    const messages = (body) => fetch(`${gateway.baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "fake-model", max_tokens: 100, ...body }) });
    res = await messages({ system: "S", messages: [{ role: "user", content: "ECHO_AGENT" }] });
    const agent = (await res.json()).content.find((block) => block.type === "text").text;
    res = await messages({
      system: "S",
      messages: [
        { role: "user", content: "ECHO_AGENT" },
        { role: "assistant", content: [{ type: "thinking", thinking: "pondering", signature: "" }, { type: "text", text: agent }] },
        { role: "user", content: [{ type: "text", text: "ECHO_PROMPT_TAIL" }] },
      ],
    });
    assert.equal((await res.json()).content.find((block) => block.type === "text").text, "ECHO_PROMPT_TAIL");
  } finally {
    await gateway.stop();
  }
});
