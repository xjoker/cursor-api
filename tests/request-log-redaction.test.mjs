// Regression tests for the request_logs table and nested/camelCase/numeric/short-value redaction.
// Every secret below is a fake test value. Only APIs that already exist on main are used
// (openDb/insertRequestLog/getRequestLogById, logInfo/setSystemLogWriter) so the same file can be
// run against older trees to show the gap.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const FAKE_API_KEY = "supersecret999";
const FAKE_BEARER = "abcdefghijklmnop";
const FAKE_MODEL_KEY = "sk-fakeABCDEFGHIJKLMNOPQRSTUV0123";

async function freshDb() {
  const { openDb, insertApiKey } = await import("../dist/db.js");
  const db = openDb(makeTempDir({ after }, "cursor-api-redact-"), {
    retentionDays: 30,
    maxRows: 100,
    maxDetailBytes: 1_048_576,
  });
  const now = new Date().toISOString();
  insertApiKey(db, { id: "key-1", name: "t", key_prefix: "cgk_test", key_digest: "d", created_at: now, updated_at: now });
  return db;
}

function logRow(overrides) {
  return {
    id: "req-1",
    api_key_id: "key-1",
    path: "/v1/chat/completions",
    model: "fake-model",
    stream: 0,
    http_status: 200,
    duration_ms: 1,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    error_code: null,
    created_at: new Date().toISOString(),
    upstream_ms: 1,
    gateway_ms: 0,
    request_detail: null,
    response_detail: null,
    ...overrides,
  };
}

async function storedRow(overrides) {
  const { insertRequestLog, getRequestLogById } = await import("../dist/db.js");
  const db = await freshDb();
  try {
    insertRequestLog(db, logRow(overrides));
    return getRequestLogById(db, "req-1");
  } finally {
    db.close();
  }
}

/** Fields as persisted to system_logs (same sanitizer as stdout). */
async function persistedFields(fields) {
  const { logInfo, setSystemLogWriter } = await import("../dist/log.js");
  let entry;
  setSystemLogWriter((next) => {
    entry = next;
  });
  try {
    logInfo("redaction probe", fields);
  } finally {
    setSystemLogWriter(undefined);
  }
  return entry.fields;
}

test("request_detail: secrets in user messages are not stored verbatim", async () => {
  const detail = JSON.stringify({
    model: "fake-model",
    messages: [{ role: "user", content: `my api_key=${FAKE_API_KEY} and Bearer ${FAKE_BEARER}` }],
    metadata: { accessToken: "fakeAccessTok" },
  });
  const row = await storedRow({ request_detail: detail });
  assert.ok(!row.request_detail.includes(FAKE_API_KEY), row.request_detail);
  assert.ok(!row.request_detail.includes(FAKE_BEARER), row.request_detail);
  assert.ok(!row.request_detail.includes("fakeAccessTok"), row.request_detail);
  assert.match(row.request_detail, /my api_key=\[redacted\] and Bearer \[redacted\]/);
  // Still valid JSON with the non-secret parts intact.
  assert.equal(JSON.parse(row.request_detail).messages[0].role, "user");
});

test("request_detail: truncated (invalid) JSON is still scrubbed as text", async () => {
  const row = await storedRow({ request_detail: `{"messages":[{"content":"Bearer ${FAKE_BEARER} api_key=${FAKE_API_KEY}\n…[truncated]` });
  assert.ok(!row.request_detail.includes(FAKE_API_KEY), row.request_detail);
  assert.ok(!row.request_detail.includes(FAKE_BEARER), row.request_detail);
});

test("response_detail / error_message: secrets are not stored verbatim", async () => {
  const detail = JSON.stringify({
    status: "error",
    text: `echo: api_key=${FAKE_API_KEY}`,
    error_code: "upstream_error",
    error_message: `upstream rejected Authorization: Bearer ${FAKE_BEARER}`,
  });
  const row = await storedRow({ response_detail: detail, error_code: "upstream_error", http_status: 502 });
  assert.ok(!row.response_detail.includes(FAKE_API_KEY), row.response_detail);
  assert.ok(!row.response_detail.includes(FAKE_BEARER), row.response_detail);
  assert.equal(JSON.parse(row.response_detail).error_code, "upstream_error");
});

test("model: a key-shaped model name is not stored verbatim", async () => {
  const row = await storedRow({ model: FAKE_MODEL_KEY, response_detail: JSON.stringify({ error_message: `unknown model ${FAKE_MODEL_KEY}` }) });
  assert.ok(!row.model.includes(FAKE_MODEL_KEY), row.model);
  assert.equal(row.model, "[redacted]");
  assert.ok(!row.response_detail.includes(FAKE_MODEL_KEY), row.response_detail);
  // Ordinary model names are untouched.
  assert.equal((await storedRow({ model: "gpt-5" })).model, "gpt-5");
});

test("nested fields: authorization inside objects and Bearer inside arrays are masked", async () => {
  const fields = await persistedFields({
    headers: { authorization: `Bearer ${FAKE_BEARER}`, "content-type": "application/json" },
    nested: [`Bearer ${FAKE_BEARER}x`, { deeper: { password: "hunter2hunter2" } }],
  });
  const text = JSON.stringify(fields);
  assert.ok(!text.includes(FAKE_BEARER), text);
  assert.ok(!text.includes("hunter2hunter2"), text);
  assert.equal(fields.headers.authorization, "[redacted]");
  assert.equal(fields.headers["content-type"], "application/json");
});

test("camelCase and *_key field names are masked; identifiers stay readable", async () => {
  const fields = await persistedFields({
    sessionToken: "fakeSessionValue",
    accessToken: "fakeAccessValue",
    admin_key: "fakeAdminValue",
    cursor_key: "fakeCursorValue",
    key: "fakeBareKeyValue",
    adminKey: "fakeAdminCamel",
    apiKeyId: "k_123",
  });
  for (const name of ["sessionToken", "accessToken", "admin_key", "cursor_key", "key", "adminKey"]) {
    assert.equal(fields[name], "[redacted]", name);
  }
  assert.equal(fields.apiKeyId, "k_123");
});

test("numeric values under sensitive names are masked; token counts are not", async () => {
  const fields = await persistedFields({ password: 123456, token: 987654321, pin_secret: 4242, input_tokens: 12, max_tokens: 4096 });
  assert.equal(fields.password, "[redacted]");
  assert.equal(fields.token, "[redacted]");
  assert.equal(fields.pin_secret, "[redacted]");
  assert.equal(fields.input_tokens, 12);
  assert.equal(fields.max_tokens, 4096);
});

test("short secret values in free text are masked; plain words stay readable", async () => {
  const fields = await persistedFields({
    a: "auth Bearer abc1234 failed",
    b: "bad config api_key=abc12 here",
    c: "authorization: myAdminPass2026",
    d: "missing Bearer header",
  });
  assert.equal(fields.a, "auth Bearer [redacted] failed");
  // b and c still name a credential, so the system log masks the whole value (since #27).
  assert.ok(!fields.b.includes("abc12"), fields.b);
  assert.ok(!fields.c.includes("myAdminPass2026"), fields.c);
  assert.equal(fields.d, "missing Bearer header");
});

test("more secret shapes: JWT, GitHub, AWS, URL userinfo, X-Management-Key, escaped newline", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsigFAKEsigFAKEsig";
  const fields = await persistedFields({
    t1: `got ${jwt} back`,
    gh: `gh ghp_${"FAKE".repeat(9)}`,
    pat: `gh github_pat_${"FAKE".repeat(10)}`,
    aws: "aws AKIAFAKEFAKEFAKEFAKE used",
    url: "fetch https://admin:FAKEpassw0rd@proxy.example/x",
    mgmt: "header X-Management-Key: FAKEmgmtvalue",
    escaped: "sent Bearer\\nFAKE0123456789abcdef",
  });
  assert.equal(fields.t1, "got [redacted] back");
  assert.equal(fields.gh, "gh [redacted]");
  assert.equal(fields.pat, "gh [redacted]");
  assert.equal(fields.aws, "aws [redacted] used");
  assert.equal(fields.url, "fetch https://admin:[redacted]@proxy.example/x");
  assert.equal(fields.mgmt, "header X-Management-Key: [redacted]");
  assert.equal(fields.escaped, "sent Bearer\\n[redacted]");
});

test("request_detail keeps prompt text that merely mentions a credential word", async () => {
  const detail = JSON.stringify({ messages: [{ role: "user", content: `how do I rotate my token? api_key=${FAKE_API_KEY}` }] });
  const row = await storedRow({ request_detail: detail });
  assert.equal(JSON.parse(row.request_detail).messages[0].content, "how do I rotate my token? api_key=[redacted]");
});

// ---- request_logs: every new shape in each of the four client-influenced fields ----

const SHAPES = {
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsigFAKEsigFAKEsig",
  ghp: `ghp_${"FAKE".repeat(9)}`,
  pat: `github_pat_${"FAKE".repeat(10)}`,
  akia: "AKIAFAKEFAKEFAKEFAKE",
};
const SHAPE_TEXT = [
  `jwt ${SHAPES.jwt}`,
  `gh ${SHAPES.ghp} / ${SHAPES.pat}`,
  `aws ${SHAPES.akia}`,
  "proxy https://admin:FAKEpassw0rd@proxy.example/x",
  "X-Management-Key: FAKEmgmtvalue123",
  "sent Bearer\\nFAKE0123456789abcdef",
].join("; ");
const SHAPE_SECRETS = [...Object.values(SHAPES), "FAKEpassw0rd", "FAKEmgmtvalue123", "FAKE0123456789abcdef"];

function assertClean(label, text) {
  for (const secret of SHAPE_SECRETS) assert.ok(!String(text).includes(secret), `${label} leaks ${secret}: ${text}`);
}

test("request_logs fields: JWT, GitHub, AWS, URL userinfo, X-Management-Key and escaped \\n are masked", async () => {
  const row = await storedRow({
    model: `model ${SHAPES.ghp}`,
    request_detail: JSON.stringify({ messages: [{ role: "user", content: SHAPE_TEXT }], [`X-Management-Key: FAKEmgmtvalue123`]: 1 }),
    response_detail: JSON.stringify({ status: "error", text: SHAPE_TEXT, error_message: `upstream said ${SHAPE_TEXT}` }),
  });
  assertClean("model", row.model);
  assertClean("request_detail", row.request_detail);
  assertClean("response_detail", row.response_detail);
  assertClean("error_message", JSON.parse(row.response_detail).error_message);
  assert.equal(row.model, "model [redacted]");
  assert.match(JSON.parse(row.request_detail).messages[0].content, /^jwt \[redacted\]; gh \[redacted\] \/ \[redacted\]; aws \[redacted\]; proxy https:\/\/admin:\[redacted\]@proxy\.example\/x; X-Management-Key: \[redacted\]; sent Bearer\\n\[redacted\]$/);
});

test("request_logs model: a JWT or AWS key pasted as the model name is masked, a long one capped", async () => {
  for (const model of [SHAPES.jwt, SHAPES.akia, `user_01FAKE::${SHAPES.jwt}`]) {
    assert.equal((await storedRow({ model })).model, "[redacted]", model);
  }
  const long = (await storedRow({ model: `${"m".repeat(300)} ${SHAPES.ghp}` })).model;
  assert.ok(Buffer.byteLength(long) <= 256 && !long.includes("ghp_"), long);
});

// ---- Elliot r2 N5 / N6 / N9: in-place rules on free text ----

test("N5: Authorization with a prefixed name is masked", async () => {
  const { scrubSecrets } = await import("../dist/log.js");
  assert.equal(scrubSecrets("HTTP_AUTHORIZATION: Token FAKEs3cr3tVALUE9x"), "HTTP_AUTHORIZATION: [redacted]");
  assert.equal(scrubSecrets("x_authorization=Token FAKEs3cr3tVALUE9x"), "x_authorization=[redacted]");
  assert.equal(scrubSecrets("unauthorization: fine"), "unauthorization: fine");
});

test("N6: values that start like null/true/[redacted] or follow a masked shape are masked whole", async () => {
  const { scrubSecrets } = await import("../dist/log.js");
  const S = "FAKEs3cr3tVALUE9x";
  const cases = {
    [`token=true-${S}`]: "token=[redacted]",
    [`password=null.${S}`]: "password=[redacted]",
    [`token=[redacted]${S}`]: "token=[redacted]",
    [`token=sk-${"a".repeat(24)}.${S}`]: "token=[redacted]",
    [`Authorization: Bearer\n${S}`]: "Authorization: [redacted]",
    [`Authorization: Bearer\\n${S}`]: "Authorization: [redacted]",
    [`Cookie: a=b; session=${S}`]: "Cookie: [redacted]",
    [`passphrase=${S}`]: "passphrase=[redacted]",
    [`tokens=${S}`]: "tokens=[redacted]",
    "token=null, retry": "token=null, retry",
    "secret: true": "secret: true",
    "token=[redacted] next": "token=[redacted] next",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(scrubSecrets(input), expected, input);
});

test("N9: pagination cursors and Basic prose are not masked", async () => {
  const { scrubSecrets, sanitizeFields } = await import("../dist/log.js");
  for (const text of ["next_page_token: abc123", "pageToken=abc123", "Basic Auth0 setup", "Basic authentication failed", "tokenizer: cl100k"]) {
    assert.equal(scrubSecrets(text), text);
  }
  assert.equal(scrubSecrets("header Basic Zm9vOmJhcg== sent"), "header Basic [redacted] sent");
  assert.equal(scrubSecrets("header Basic dXNlcjE6cGFzczE sent"), "header Basic [redacted] sent");
  assert.deepEqual(sanitizeFields({ next_page_token: "abc123", pageToken: "abc123" }), { next_page_token: "abc123", pageToken: "abc123" });
});

test("client-controlled field names in stored bodies are scrubbed too", async () => {
  const row = await storedRow({ request_detail: JSON.stringify({ [`token=${SHAPES.jwt}`]: 1, [`X-Management-Key: FAKEmgmtvalue123`]: 2, ok: 3 }) });
  assertClean("request_detail keys", row.request_detail);
  assert.equal(JSON.parse(row.request_detail).ok, 3);
});

// ---- linear time for the request_logs path ----

test("request_logs redaction stays within a linear time bound from 1 KiB to 1 MiB", async () => {
  const { insertRequestLog } = await import("../dist/db.js");
  const { scrubSecrets } = await import("../dist/log.js");
  const shapes = {
    word_run: (n) => "a".repeat(n),
    jwt_dashes: (n) => "eyJ-".repeat(Math.ceil(n / 4)).slice(0, n),
    dotted: (n) => "a.".repeat(n / 2),
    url_like: (n) => `a://${"b".repeat(n - 6)}:c`,
    colons: (n) => "a:".repeat(n / 2),
    cookie_lines: (n) => "Cookie: a=b; ".repeat(Math.ceil(n / 13)).slice(0, n),
    authz_repeat: (n) => "Authorization: Bearer ".repeat(Math.ceil(n / 22)).slice(0, n),
    bearer_ws: (n) => `Bearer${" ".repeat(n - 6)}`,
  };
  const bound = (bytes) => 40 + (bytes / 1024) * 0.5;
  const db = await freshDb();
  try {
    for (const [name, make] of Object.entries(shapes)) {
      for (const size of [1_024, 16_384, 65_536, 262_144, 1_048_576]) {
        const text = make(size);
        scrubSecrets(text);
        let started = performance.now();
        scrubSecrets(text);
        let ms = performance.now() - started;
        assert.ok(ms <= bound(size), `scrubSecrets ${name} @ ${size}: ${ms.toFixed(1)} ms`);
        const detail = JSON.stringify({ messages: [{ role: "user", content: text }] });
        started = performance.now();
        insertRequestLog(db, logRow({ id: `t-${name}-${size}`, model: text, request_detail: detail, response_detail: text }));
        ms = performance.now() - started;
        assert.ok(ms <= bound(size) * 3 + 50, `insertRequestLog ${name} @ ${size}: ${ms.toFixed(1)} ms`);
      }
    }
  } finally {
    db.close();
  }
});

// ---- after rebasing onto #39 r4 (caff3a8) ----

test("response_detail error_message gets the raw-text check, not in-place masking only (R3-3 shape)", async () => {
  const SECRET = "FAKEzzSECRETqq1";
  for (const message of [`Bearer token_abcdefgh ${SECRET}`, `password ${SECRET}`, `usage limit: api key is ${SECRET}`]) {
    const row = await storedRow({
      response_detail: JSON.stringify({ status: "error", text: "see the token docs", error_message: message }),
    });
    const detail = JSON.parse(row.response_detail);
    assert.equal(detail.error_message, "[redacted]", message);
    assert.ok(!row.response_detail.includes(SECRET), row.response_detail);
    // Body text keeps in-place masking only: a prompt/answer that mentions a credential word stays readable.
    assert.equal(detail.text, "see the token docs");
  }
  for (const readable of ["The model 'fake-model' does not exist", "max_tokens must be a positive integer"]) {
    const row = await storedRow({ response_detail: JSON.stringify({ status: "error", error_message: readable }) });
    assert.equal(JSON.parse(row.response_detail).error_message, readable);
  }
});

test("plural count values stay readable in JSON text; anything glued to the number is masked", async () => {
  const readable = '{"max_tokens":4096} {"max_tokens":null} max_tokens=-1 is too small; tokens=1.5';
  const row = await storedRow({ request_detail: JSON.stringify({ messages: [{ role: "user", content: readable }] }) });
  assert.equal(JSON.parse(row.request_detail).messages[0].content, readable);
  for (const leaky of ["tokens=4096}FAKEzzSECRETqq1", "tokens=4096-FAKEzzSECRETqq1", "refresh_tokens: 12FAKEzzSECRETqq1"]) {
    const masked = await storedRow({ request_detail: JSON.stringify({ messages: [{ role: "user", content: leaky }] }) });
    assert.ok(!masked.request_detail.includes("FAKEzz"), masked.request_detail);
  }
});

test("8 MiB runs of the new shapes in a stored body do not hit the fail-closed path (no RangeError)", async () => {
  const { redactValue } = await import("../dist/log.js");
  const N = 8 * 1024 * 1024;
  const cases = [
    [`ghp_${"a".repeat(N)} TAIL`, "[redacted] TAIL"],
    [`Bearer ${"a".repeat(N)} TAIL`, "Bearer [redacted] TAIL"],
    [`Basic ${"a".repeat(N)}1 TAIL`, "Basic [redacted] TAIL"],
    [`github_pat_${"a".repeat(N)} TAIL`, "[redacted] TAIL"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactValue({ content: input }).content, expected, input.slice(0, 12));
  }
  // Runs that no rule masks are kept as is, not failed closed: `eyJ` without dots is not a JWT,
  // and `Basic <run>1===` reaches every Basic alternative (and fails them all).
  for (const kept of [`eyJ${"a".repeat(N)} TAIL`, `Basic ${"a".repeat(N)}1=== TAIL`]) {
    assert.equal(redactValue({ content: kept }).content.length, kept.length, kept.slice(0, 8));
  }
});

test("a field name with a credential shape or a credential word plus a secret is replaced whole", async () => {
  const SECRET = "FAKEzzUNKNOWNqq7";
  const row = await storedRow({
    request_detail: JSON.stringify({
      [`Bearer token_abcdefgh ${SECRET}`]: 1,
      [`password ${SECRET}`]: 2,
      access_token: "FAKEzzVALUEqq5",
      password: { type: "string" },
      "max_tokens must be set": 4,
      "plain name": 5,
    }),
  });
  assert.ok(!row.request_detail.includes(SECRET), row.request_detail);
  assert.ok(!row.request_detail.includes("FAKEzzVALUEqq5"), row.request_detail);
  const stored = JSON.parse(row.request_detail);
  assert.equal(stored.access_token, "[redacted]");
  assert.equal(stored.password, "[redacted]");
  // Name kept (count phrase + prose word); its value follows the #39 name rules.
  assert.ok("max_tokens must be set" in stored, row.request_detail);
  assert.equal(stored["plain name"], 5);
  assert.ok("[redacted]" in stored);
});
