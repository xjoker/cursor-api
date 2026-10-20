// End-to-end request_logs redaction over HTTP against the fake Cursor SDK. Every secret below is a
// synthetic fake. Each test sends requests whose secrets would land in one of the four
// client-influenced request_logs fields (request_detail, response_detail, the error_message inside
// response_detail, model) and then reads the rows back through the admin API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const ADMIN = "it-admin-key";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsigFAKEsigFAKEsig";
const GHP = `ghp_${"FAKE".repeat(9)}`;
const PAT = `github_pat_${"FAKE".repeat(10)}`;
const AKIA = "AKIAFAKEFAKEFAKEFAKE";
const URL_PASS = "FAKEpassw0rd";
const MGMT = "FAKEmgmtvalue123";
const ESCAPED = "FAKE0123456789abcdef";
const CGK = "cgk_FAKEFAKEFAKEFAKE";
const SECRETS = [JWT, GHP, PAT, AKIA, URL_PASS, MGMT, ESCAPED, CGK, "FAKEs3cr3tVALUE9x"];
const PROMPT = [
  `jwt ${JWT}`,
  `gh ${GHP} and ${PAT}`,
  `aws ${AKIA}`,
  `proxy https://admin:${URL_PASS}@proxy.example/x`,
  `X-Management-Key: ${MGMT}`,
  `Authorization: Bearer\n${ESCAPED}`,
  `key ${CGK}`,
  "api_key=FAKEs3cr3tVALUE9x",
].join("; ");

async function post(gateway, path, body, headers = {}) {
  const res = await fetch(`${gateway.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function storedRows(gateway) {
  const headers = { authorization: `Bearer ${ADMIN}` };
  const list = await (await fetch(`${gateway.baseUrl}/admin/api/logs?limit=200`, { headers })).json();
  const details = [];
  for (const row of list.logs) {
    details.push(await (await fetch(`${gateway.baseUrl}/admin/api/logs/${encodeURIComponent(row.id)}`, { headers })).json());
  }
  return { listText: JSON.stringify(list), details };
}

function assertNoSecrets(label, text) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label} leaks ${secret.slice(0, 12)}…: ${text.slice(0, 400)}`);
}

test("request_logs: request_detail, response_detail, error_message and model are redacted (detailed logging)", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ LOG_DETAILED: "true", LOG_DETAILED_MAX_BYTES: "4096" });
  try {
    // 200 paths: request_detail carries the prompt; response_detail the result.
    assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: PROMPT }], metadata: { accessToken: "FAKEs3cr3tVALUE9x" } })).status, 200);
    assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", stream: true, messages: [{ role: "user", content: PROMPT }] })).status, 200);
    assert.equal((await post(gateway, "/v1/responses", { model: "fake-model", input: PROMPT })).status, 200);
    // Secret pasted into the model name: model column + "The model '<secret>' does not exist" error_message.
    for (const secret of [GHP, JWT, AKIA, CGK]) {
      assert.equal((await post(gateway, "/v1/chat/completions", { model: secret, messages: [{ role: "user", content: "hi" }] })).status, 404);
    }
    assert.equal((await post(gateway, "/v1/responses", { model: `https://u:${URL_PASS}@m.example`, input: "hi" })).status, 404);
    // Invalid body: raw-body snapshot path and an error_message that echoes the field name.
    assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: PROMPT, extra: { headers: { authorization: `Bearer ${ESCAPED}` } } })).status, 400);
    assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: "hi" }], [`X-Management-Key: ${MGMT}`]: 1 })).status, 400);
    // A secret straddling the 4096-byte detail cut: redacted before truncation. The pad sweep puts
    // the cut at every position inside the token, so a truncate-then-scrub order would leave a
    // partial `ghp_FAKE…` that no pattern matches any more.
    for (let pad = 3_960; pad <= 4_060; pad += 4) {
      assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: `${"x".repeat(pad)} ${GHP} tail` }] })).status, 200);
    }

    const { listText, details } = await storedRows(gateway);
    assert.ok(details.length >= 12, `expected the rows, got ${details.length}`);
    assertNoSecrets("admin list", listText);
    for (const row of details) {
      assert.ok(!String(row.request_detail).includes("ghp_FAKE"), `partial GitHub token in ${String(row.request_detail).slice(-80)}`);
      assertNoSecrets(`model of ${row.path}`, row.model);
      assertNoSecrets(`request_detail of ${row.path}`, String(row.request_detail));
      assertNoSecrets(`response_detail of ${row.path}`, String(row.response_detail));
    }
    const notFound = details.filter((row) => row.error_code === "model_not_found");
    assert.equal(notFound.length, 5);
    for (const row of notFound) {
      assert.match(row.model, /\[redacted\]/);
      assert.match(JSON.parse(row.response_detail).error_message, /The model '.*\[redacted\].*' does not exist/);
    }
    const ok = details.find((row) => row.http_status === 200 && row.path === "/v1/chat/completions" && row.stream === 0 && String(row.request_detail).includes("jwt"));
    assert.ok(ok, "non-stream chat row");
    const request = JSON.parse(ok.request_detail);
    assert.match(request.messages[0].content, /jwt \[redacted\]; gh \[redacted\] and \[redacted\]; aws \[redacted\]/);
    assert.match(request.messages[0].content, /https:\/\/admin:\[redacted\]@proxy\.example/);
    assert.equal(JSON.parse(ok.response_detail).text, "PONG");
  } finally {
    await gateway.stop();
  }
});

test("request_logs: the error snapshot written with detailed logging off is redacted too", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ LOG_DETAILED: "false" });
  try {
    assert.equal((await post(gateway, "/v1/chat/completions", { model: GHP, messages: [{ role: "user", content: "hi" }] })).status, 404);
    assert.equal((await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: "hi" }], [`token=${JWT}`]: 1 })).status, 400);
    const { listText, details } = await storedRows(gateway);
    assert.equal(details.length, 2);
    assertNoSecrets("admin list", listText);
    for (const row of details) {
      assert.equal(row.request_detail, null);
      assert.ok(row.response_detail, "error snapshot is stored");
      assertNoSecrets("model", row.model);
      assertNoSecrets("response_detail", row.response_detail);
    }
  } finally {
    await gateway.stop();
  }
});

test("request_logs: an error_message echoing a credential word with a secret is masked whole (R3-3 shape)", { timeout: 30_000 }, async () => {
  const SECRET = "FAKEzzSECRETqq1";
  for (const detailed of ["false", "true"]) await errorEchoCase(detailed, SECRET);
  // A long echo cuts response_detail at detailed_max_bytes, so the final pass in insertRequestLog
  // only sees invalid JSON and scrubs it as text: the error_message check must run before the cut.
  await errorEchoCase("true", SECRET, ` ${"x".repeat(6_000)}`);
});

async function errorEchoCase(detailed, SECRET, pad = "") {
  const gateway = await startFakeGateway({ LOG_DETAILED: detailed, LOG_DETAILED_MAX_BYTES: "4096" });
  try {
    // `Unknown field '<name>'`: in-place masking alone would keep the secret after `Bearer [redacted]`.
    const res = await post(gateway, "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: "hi" }], [`Bearer token_abcdefgh ${SECRET}${pad}`]: 1 });
    assert.equal(res.status, 400);
    const { listText, details } = await storedRows(gateway);
    assert.equal(details.length, 1);
    assert.ok(!listText.includes(SECRET), listText);
    assert.ok(!String(details[0].response_detail).includes(SECRET), details[0].response_detail);
    assert.equal(JSON.parse(details[0].response_detail).error_message, "[redacted]");
    // With detailed logging the raw body snapshot keeps the field name: it is replaced whole.
    assert.ok(!String(details[0].request_detail).includes(SECRET), details[0].request_detail);
  } finally {
    await gateway.stop();
  }
}
