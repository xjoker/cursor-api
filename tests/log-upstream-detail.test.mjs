// r3 review R3-3: upstream error text reaches the log through src/cursor.ts (`cursor run failed`
// upstream_message, and GatewayError.message logged later as `error_message`). The whole-value check
// must see the raw upstream text, not text that scrubSecrets already rewrote. All secrets are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorSdkError, NetworkError } from "@cursor/sdk";
import { mapCursorError, runFailureError } from "../dist/cursor.js";
import { logInfo, setSystemLogWriter } from "../dist/log.js";

const S = "FAKEs3cr3tVALUE9x";
const REDACTED = "[redacted]";

/** Upstream error texts where an in-place rule swallows the credential word next to the secret. */
const UPSTREAM_TEXTS = [
  `Bearer token_x ${S}`,
  `Bearer token_abcdefgh ${S}`,
  `user_01AB::password ${S}`,
  `key-secret_abcdefghijklmnopqrstuv ${S}`,
  `cgk_token_abcdef ${S}`,
];

function capture(fn) {
  const lines = [];
  const persisted = [];
  let buffer = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  setSystemLogWriter((entry) => persisted.push(entry));
  process.stdout.write = (chunk) => ((buffer += chunk), true);
  process.stderr.write = (chunk) => ((buffer += chunk), true);
  let result;
  try {
    result = fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    setSystemLogWriter(undefined);
  }
  for (const line of buffer.split("\n")) if (line.trim()) lines.push(JSON.parse(line));
  return { result, lines, persisted, raw: buffer };
}

/** What index.ts does with a GatewayError after a failed chat/messages/responses request. */
function logCompleted(message) {
  return capture(() => logInfo("chat completed", { status: 502, error_message: message }));
}

test("cursor run failed: upstream_message is masked whole when the raw text has a credential word", () => {
  for (const text of UPSTREAM_TEXTS) {
    const { result: mapped, lines, persisted, raw } = capture(() => runFailureError({ message: text, code: "internal" }));
    assert.ok(!raw.includes(S), `stdout/stderr leaked for ${text}: ${raw}`);
    const run = lines.find((line) => line.message === "cursor run failed");
    assert.equal(run.upstream_message, REDACTED, text);
    assert.equal(persisted.find((e) => e.message === "cursor run failed").fields.upstream_message, REDACTED, text);
    // The client-facing message carries no secret either, and neither does the later error_message log.
    assert.equal(mapped.message, `Cursor request failed: ${REDACTED}`, text);
    const completed = logCompleted(mapped.message);
    assert.ok(!completed.raw.includes(S), completed.raw);
    assert.ok(!JSON.stringify(completed.persisted).includes(S));
  }
});

test("mapped SDK errors: error_message carries no secret from the upstream text", () => {
  for (const text of UPSTREAM_TEXTS) {
    for (const error of [
      new CursorSdkError(text, { status: 418 }),
      new CursorSdkError(text, { status: 500 }),
      new CursorSdkError(text, { status: 504 }),
      new NetworkError(text),
    ]) {
      const { result: mapped, raw } = capture(() => mapCursorError(error));
      assert.ok(!raw.includes(S), raw);
      assert.ok(!mapped.message.includes(S), `${error.status} ${mapped.message}`);
      assert.ok(mapped.message.endsWith(`: ${REDACTED}`), mapped.message);
      const completed = logCompleted(mapped.message);
      assert.ok(!completed.raw.includes(S), completed.raw);
      assert.ok(!JSON.stringify(completed.persisted).includes(S));
    }
  }
});

test("upstream text without a credential word is kept, and a multi-MB upstream message does not throw", () => {
  const { result: mapped, lines } = capture(() => runFailureError({ message: "tool crashed", code: "internal" }));
  assert.equal(mapped.message, "Cursor request failed: tool crashed");
  assert.equal(lines[0].upstream_message, "tool crashed");
  // R3-4: cursor.ts used to run the uncapped scrubSecrets on the upstream text.
  const huge = `Bearer ${"a".repeat(16 * 1024 * 1024)}`;
  const { result: big, raw } = capture(() => runFailureError({ message: huge, code: "internal" }));
  assert.ok(big.message.length < 400, `${big.message.length}`);
  assert.ok(!/a{64}/.test(raw), "the long run must not reach the log");
  const sdk = capture(() => mapCursorError(new CursorSdkError(huge, { status: 418 }))).result;
  assert.ok(sdk.message.length < 400 && !/a{64}/.test(sdk.message));
});
