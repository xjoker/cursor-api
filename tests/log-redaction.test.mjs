import assert from "node:assert/strict";
import { test } from "node:test";
import { logError, logInfo, sanitizeFields, scrubSecrets, setSystemLogWriter } from "../dist/log.js";

test("nested arrays redact both free text secrets and credential fields", () => {
  const out = sanitizeFields({ nested: [{ input_tokens: 5, token: "private" }, "Bearer cgk_abcdefghijklmnop"] });
  assert.deepEqual(out, { nested: [{ input_tokens: 5, token: "[redacted]" }, "Bearer [redacted]"] });
});

test("token counts and ordinary text survive redaction", () => {
  const out = sanitizeFields({
    input_tokens: 120,
    output_tokens: 45,
    max_tokens: 4096,
    total_tokens: 165,
    error: "max_tokens must be a positive integer",
    model: "gpt-5",
    api_key_id: "k_123",
    key_prefix: "cgk_abc",
  });
  assert.deepEqual(out, {
    input_tokens: 120,
    output_tokens: 45,
    max_tokens: 4096,
    total_tokens: 165,
    error: "max_tokens must be a positive integer",
    model: "gpt-5",
    api_key_id: "k_123",
    key_prefix: "cgk_abc",
  });
});

test("credential fields are redacted whatever their value", () => {
  const out = sanitizeFields({
    api_key: "anything",
    authorization: "Bearer abc",
    "x-api-key": "k",
    admin_access_key: "admin",
    api_key_pepper: "p",
    token: "t",
    refresh_token: "r",
    client_secret: "s",
    password: "pw",
    cookie: "sid=1",
  });
  for (const value of Object.values(out)) assert.equal(value, "[redacted]");
});

test("secrets embedded in free text are masked in place", () => {
  assert.equal(scrubSecrets("auth Bearer cgk_abcdefgh12345 failed"), "auth Bearer [redacted] failed");
  assert.equal(scrubSecrets("key cgk_abcdef123456 disabled"), "key [redacted] disabled");
  assert.equal(scrubSecrets("upstream rejected key_0123456789abcdefghijklmn"), "upstream rejected [redacted]");
  assert.equal(scrubSecrets("bad config api_key=supersecretvalue here"), "bad config api_key=[redacted] here");
  assert.equal(scrubSecrets('{"token": "abcdef123456"}'), '{"token": "[redacted]"}');
  assert.equal(scrubSecrets("request failed after 3 retries"), "request failed after 3 retries");
});

// Synthetic credentials used to verify both log sinks.
const FAKE = "FAKE0123456789abcdefFAKE";

/** Runs one log call and returns both sinks: the stdout/stderr JSON line and the persisted entry. */
function capture(fn) {
  let persisted;
  let line = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  setSystemLogWriter((entry) => {
    persisted = entry;
  });
  process.stdout.write = (chunk) => ((line += chunk), true);
  process.stderr.write = (chunk) => ((line += chunk), true);
  try {
    fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    setSystemLogWriter(undefined);
  }
  return { stdout: JSON.parse(line), persisted };
}

test("cgk_ keys are masked when the text also contains ':' or '='", () => {
  assert.equal(scrubSecrets("error: key cgk_FAKEabcdef123456 disabled"), "error: key [redacted] disabled");
  assert.equal(scrubSecrets("a=b key cgk_FAKEabcdef123456"), "a=b key [redacted]");
  assert.deepEqual(sanitizeFields({ detail: "a=b key cgk_FAKEabcdef123456" }), { detail: "a=b key [redacted]" });
});

test("redaction output stays proportional to its input and logging never throws", () => {
  const inputs = [
    "cgk_FAKEab: ".repeat(3000),
    "x=1 cgk_FAKEabcdef ".repeat(2000),
    "token=x ".repeat(2000),
    "Authorization: Token abc ".repeat(2000),
    "Bearer abcdefghij ".repeat(2000),
    "user_01FAKE::eyJFAKE.FAKE.FAKE ".repeat(2000),
  ];
  for (const input of inputs) {
    const out = scrubSecrets(input);
    assert.ok(out.length <= input.length * 2.5, `amplified ${input.slice(0, 20)}: ${input.length} -> ${out.length}`);
    assert.ok(!out.includes(input), "input must not be copied into the output");
  }
  const huge = "auth failed: " + "cgk_FAKEab ".repeat(12000);
  const { stdout, persisted } = capture(() => logError(huge, { error_message: huge }));
  assert.ok(stdout.message.length <= huge.length);
  assert.ok(!stdout.message.includes("cgk_FAKEab"));
  assert.ok(!persisted.message.includes("cgk_FAKEab"));
});

test("field values that the old sanitizer masked stay masked in stdout and system_logs", () => {
  const values = [
    `refresh_token=${FAKE}`,
    `Authorization: Token ${FAKE}`,
    `client_secret=${FAKE}`,
    `{"access_token":"${FAKE}"}`,
    `401 {"error":"invalid_token","access_token":"${FAKE}"}`,
    "password=abc12",
    `Unknown field 'refresh_token=${FAKE}'`,
  ];
  for (const value of values) {
    const { stdout, persisted } = capture(() => logError("upstream failed", { error_message: value }));
    for (const sink of [stdout.error_message, persisted.fields.error_message]) {
      assert.ok(!sink.includes(FAKE) && !sink.includes("abc12"), `${value} -> ${sink}`);
    }
  }
  // No known shape, but a credential word is present: the whole value is masked, as before #27.
  const loose = capture(() => logError("upstream failed", { error_message: `the secret is ${FAKE}` }));
  assert.equal(loose.stdout.error_message, "[redacted]");
  assert.equal(loose.persisted.fields.error_message, "[redacted]");
  // Count wording is not a credential.
  assert.equal(capture(() => logInfo("m", { error: "max_tokens must be a positive integer" })).persisted.fields.error, "max_tokens must be a positive integer");
});

test("free-text key=value forms are masked in messages, including short values", () => {
  const cases = {
    [`access_token=${FAKE}&x=1`]: "access_token=[redacted]&x=1",
    [`refresh_token=${FAKE}`]: "refresh_token=[redacted]",
    [`client_secret: ${FAKE}`]: "client_secret: [redacted]",
    [`aws_secret_access_key=${FAKE}`]: "aws_secret_access_key=[redacted]",
    [`Authorization: Token ${FAKE}`]: "Authorization: [redacted]",
    [`{"access_token":"${FAKE}"}`]: '{"access_token":"[redacted]"}',
    [`{\\"token\\": \\"${FAKE}\\"}`]: '{\\"token\\": \\"[redacted]\\"}',
    "password=abc12": "password=[redacted]",
    "token: 4096 tokens used": "token: 4096 tokens used",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(scrubSecrets(input), expected, input);
});

test("credential field names are matched in camelCase and with any suffix", () => {
  const names = [
    "accessToken", "AccessToken", "refreshToken", "sessionToken", "WorkosCursorSessionToken",
    "tokenValue", "token_hash", "client_secret_name", "token_source", "x-cursor-token", "private_key", "jwt",
  ];
  const out = sanitizeFields(Object.fromEntries(names.map((name) => [name, FAKE])));
  for (const name of names) assert.equal(out[name], "[redacted]", name);
  const kept = { api_key_id: "k_1", apiKeyId: "k_2", key_prefix: "cgk_abc", input_tokens: 1, inputTokens: 2, maxTokens: 3, prompt_token_count: 4, "input-tokens": 120 };
  assert.deepEqual(sanitizeFields(kept), kept);
});

test("numbers and booleans under credential names are masked", () => {
  assert.deepEqual(sanitizeFields({ password: 12345678, pin_secret: 4242, token: 987654321, api_key: true }), {
    password: "[redacted]",
    pin_secret: "[redacted]",
    token: "[redacted]",
    api_key: "[redacted]",
  });
});

test("Cursor session tokens are masked whole; plain user_ ids and Basic prose are not", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsigFAKEsigFAKEsig";
  assert.equal(scrubSecrets(`cookie user_01FAKEFAKEFAKEFAKE::${jwt}`), "cookie [redacted]");
  assert.equal(scrubSecrets(`WorkosCursorSessionToken=user_01FAKEFAKEFAKEFAKE%3A%3A${jwt}`), "WorkosCursorSessionToken=[redacted]");
  assert.equal(scrubSecrets("model user_preferences_dialog_component_v2 ok"), "model user_preferences_dialog_component_v2 ok");
  assert.equal(scrubSecrets("Basic authentication failed"), "Basic authentication failed");
  assert.equal(scrubSecrets("header Basic Zm9vOmJhcg== sent"), "header Basic [redacted] sent");
});

test("stdout and system_logs both mask the message and field values", () => {
  const { stdout, persisted } = capture(() =>
    logInfo(`upstream said Bearer ${FAKE}`, { detail: `retry with api_key=${FAKE}`, note: "key cgk_FAKEabcdef123456 used" }),
  );
  for (const sink of [stdout.message, persisted.message]) assert.equal(sink, "upstream said Bearer [redacted]");
  for (const sink of [stdout.detail, persisted.fields.detail]) assert.ok(!sink.includes(FAKE), sink);
  for (const sink of [stdout.note, persisted.fields.note]) assert.equal(sink, "key [redacted] used");
});
