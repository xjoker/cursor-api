import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CLIENT_KEY, parseSse, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const HEADERS = {
  authorization: `Bearer ${CLIENT_KEY}`,
  "content-type": "application/json",
};

function writeGatewayConfig(root, extra = []) {
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    [
      'cursor_api_key = "key"',
      'admin_access_key = "admin"',
      'api_key_pepper = "pepper"',
      ...extra,
      "",
    ].join("\n"),
  );
}

function baseConfigEnv(extra = {}) {
  return {
    DATA_DIR: "data",
    CURSOR_API_KEY: "key",
    ADMIN_ACCESS_KEY: "admin",
    API_KEY_PEPPER: "pepper",
    ...extra,
  };
}

function post(gateway, path, body, options = {}) {
  return fetch(`${gateway.baseUrl}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    ...options,
  });
}

function bodyFor(path, stream = false, content = "SLOW_STREAM IGNORE_CANCEL") {
  return path === "/v1/responses"
    ? { model: "fake-model", input: content, stream }
    : { model: "fake-model", messages: [{ role: "user", content }], stream };
}

async function waitFor(check, label, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function ledgerEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestRequestLog(gateway) {
  const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"), { timeout: 5_000 });
  try {
    return db.prepare("SELECT * FROM request_logs ORDER BY rowid DESC LIMIT 1").get();
  } finally {
    db.close();
  }
}

function currentUsage(gateway) {
  const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"), { timeout: 5_000 });
  try {
    return db.prepare("SELECT * FROM api_key_usage WHERE api_key_id = 'it-key' AND period_start = 'total'").get();
  } finally {
    db.close();
  }
}

test("request lifecycle intervals use env over TOML and retain bounded defaults", (context) => {
  const root = makeTempDir(context, "cursor-api-request-config-");
  writeGatewayConfig(root, ["request_timeout_ms = 321", "shutdown_timeout_ms = 654"]);

  const fromToml = loadConfig(baseConfigEnv(), root);
  assert.equal(fromToml.requestTimeoutMs, 321);
  assert.equal(fromToml.shutdownTimeoutMs, 654);

  const fromEnv = loadConfig(
    baseConfigEnv({ REQUEST_TIMEOUT_MS: "123", SHUTDOWN_TIMEOUT_MS: "456" }),
    root,
  );
  assert.equal(fromEnv.requestTimeoutMs, 123);
  assert.equal(fromEnv.shutdownTimeoutMs, 456);

  const defaultsRoot = makeTempDir(context, "cursor-api-request-config-default-");
  writeGatewayConfig(defaultsRoot);
  const defaults = loadConfig(baseConfigEnv(), defaultsRoot);
  assert.equal(defaults.requestTimeoutMs, 300_000);
  assert.equal(defaults.shutdownTimeoutMs, 10_000);
  assert.equal(loadConfig(baseConfigEnv({ REQUEST_TIMEOUT_MS: "0" }), defaultsRoot).requestTimeoutMs, 0);
  assert.throws(() => loadConfig(baseConfigEnv({ REQUEST_TIMEOUT_MS: "86400001" }), defaultsRoot), /REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadConfig(baseConfigEnv({ SHUTDOWN_TIMEOUT_MS: "0" }), defaultsRoot), /SHUTDOWN_TIMEOUT_MS/);
});

test("deadline covers model preflight and returns one 504 without dispatch", { timeout: 20_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-request-ledger-");
  const ledger = join(ledgerDir, "events.jsonl");
  const gateway = await startFakeGateway(
    {
      REQUEST_TIMEOUT_MS: "150",
      FAKE_SDK_PRECHECK_DELAY_MS: "700",
      FAKE_SDK_LEDGER: ledger,
    },
    { keyPolicy: { allowed_models: ["fake-model"] } },
  );
  try {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const response = await post(gateway, path, bodyFor(path, false, "preflight timeout"));
      assert.equal(response.status, 504, path);
      const body = await response.json();
      assert.equal(body.error.code, "request_timeout", path);
    }
    await waitFor(() => {
      const events = ledgerEvents(ledger);
      return events.filter((event) => event.event === "preflight_done").length >= 2 ? events : undefined;
    }, "preflight attempts settled");
    assert.equal(ledgerEvents(ledger).some((event) => event.event === "dispatch"), false);
  } finally {
    await gateway.stop();
  }
});

test("create timeout disposes a late agent and does not leave a live session", { timeout: 20_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-create-ledger-");
  const ledger = join(ledgerDir, "events.jsonl");
  const gateway = await startFakeGateway({
    REQUEST_TIMEOUT_MS: "150",
    FAKE_SDK_CREATE_DELAY_MS: "700",
    MAX_LIVE_SESSIONS: "1",
    FAKE_SDK_LEDGER: ledger,
  });
  try {
    const response = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions"));
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "request_timeout");
    const blocked = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "capacity while create is pending"));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, "too_many_sessions");
    const events = await waitFor(() => {
      const current = ledgerEvents(ledger);
      return current.some((event) => event.event === "dispose") ? current : undefined;
    }, "late create disposal");
    assert.equal(events.some((event) => event.event === "dispatch"), false);
    assert.match(gateway.output(), /request_timeout/);
  } finally {
    await gateway.stop();
  }
});

test("send timeout marks unknown dispatch conservatively and retains pending capacity until late send settles", { timeout: 30_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-send-delay-ledger-");
  const ledger = join(ledgerDir, "events.jsonl");
  const gateway = await startFakeGateway(
    {
      REQUEST_TIMEOUT_MS: "150",
      FAKE_SDK_SEND_DELAY_MS: "700",
      MAX_LIVE_SESSIONS: "1",
      FAKE_SDK_LEDGER: ledger,
    },
    { keyPolicy: { quota_tokens: 100_000 } },
  );
  try {
    const timedOut = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "send promise timeout"));
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, "request_timeout");
    assert.ok((currentUsage(gateway)?.requests ?? 0) === 1, "the send attempt remains a settled request");
    assert.ok((currentUsage(gateway)?.tokens ?? 0) > 0, "unknown send dispatch keeps the reservation");

    const blocked = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "capacity while send is pending"));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, "too_many_sessions");
    await waitFor(() => ledgerEvents(ledger).some((event) => event.event === "dispose"), "late send disposal");
    const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"), { timeout: 5_000 });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE api_key_id = 'it-key'").get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    await gateway.stop();
  }
});

test("a started run deadline is 504, settles quota once, and frees the concurrency slot", { timeout: 30_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-send-ledger-");
  const ledger = join(ledgerDir, "events.jsonl");
  const gateway = await startFakeGateway(
    {
      REQUEST_TIMEOUT_MS: "150",
      FAKE_SDK_LEDGER: ledger,
    },
    { keyPolicy: { quota_tokens: 100_000, max_concurrent: 1 } },
  );
  try {
    const timedOut = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions"));
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, "request_timeout");
    const row = await waitFor(() => latestRequestLog(gateway), "timeout request log");
    assert.equal(row.http_status, 504);
    assert.equal(row.error_code, "request_timeout");
    assert.ok((currentUsage(gateway)?.tokens ?? 0) > 0, "started request retains a conservative reservation");

    const after = await post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "fast"));
    assert.equal(after.status, 200, "timeout must release the HTTP concurrency slot");
    assert.ok(ledgerEvents(ledger).some((event) => event.event === "dispatch"));
  } finally {
    await gateway.stop();
  }
});

test("stream deadlines preserve protocol framing and distinguish disconnects", { timeout: 30_000 }, async (context) => {
  const ledger = join(makeTempDir(context, "cursor-api-disconnect-ledger-"), "events.jsonl");
  const gateway = await startFakeGateway({ REQUEST_TIMEOUT_MS: "150", FAKE_SDK_LEDGER: ledger });
  try {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const response = await post(gateway, path, bodyFor(path, true));
      assert.equal(response.status, 200, path);
      const frames = parseSse(await response.text());
      const error = frames.find((frame) => frame.data?.error?.code === "request_timeout");
      assert.ok(error, `${path} emits a request timeout error frame`);
      if (path === "/v1/chat/completions") assert.ok(frames.some((frame) => frame.data === "[DONE]"));
      else assert.ok(frames.some((frame) => frame.event === "response.failed"));
      assert.equal(frames.some((frame) => frame.data?.error?.code === "cancelled"), false);
    }

    const controller = new AbortController();
    const beforeDisconnect = ledgerEvents(ledger).length;
    const pending = post(
      gateway,
      "/v1/chat/completions",
      bodyFor("/v1/chat/completions", false, "SLOW_STREAM"),
      { signal: controller.signal },
    );
    await waitFor(
      () => ledgerEvents(ledger).slice(beforeDisconnect).some((event) => event.event === "send_started"),
      "disconnect request accepted by fake SDK",
    );
    controller.abort();
    await pending.catch(() => undefined);
    const row = await waitFor(() => {
      const current = latestRequestLog(gateway);
      return current?.error_code === "cancelled" ? current : undefined;
    }, "client disconnect log");
    assert.equal(row.http_status, 499);
  } finally {
    await gateway.stop();
  }
});

test("parking survives the originating deadline and the continuation gets a fresh deadline", { timeout: 30_000 }, async () => {
  const gateway = await startFakeGateway({ REQUEST_TIMEOUT_MS: "150", PARK_TIMEOUT_MS: "5000" });
  try {
    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
    const first = await post(gateway, "/v1/chat/completions", {
      model: "fake-model",
      conversation_id: "deadline-park",
      tools,
      messages: [{ role: "user", content: "CALL_TOOL" }],
    });
    const parked = await first.json();
    assert.equal(first.status, 200);
    assert.equal(parked.choices[0].finish_reason, "tool_calls");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const call = parked.choices[0].message.tool_calls[0];
    const continued = await post(gateway, "/v1/chat/completions", {
      model: "fake-model",
      conversation_id: "deadline-park",
      tools,
      messages: [
        { role: "user", content: "CALL_TOOL" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "sunny" },
      ],
    });
    assert.equal(continued.status, 200);
    assert.match((await continued.json()).choices[0].message.content, /sunny/);
  } finally {
    await gateway.stop();
  }
});

test("SIGTERM drains an in-flight handler and repeated signals remain idempotent", { timeout: 30_000 }, async (context) => {
  const ledger = join(makeTempDir(context, "cursor-api-drain-ledger-"), "events.jsonl");
  const gateway = await startFakeGateway({ SHUTDOWN_TIMEOUT_MS: "1500", FAKE_SDK_DELAY_MS: "350", FAKE_SDK_LEDGER: ledger });
  try {
    const pending = post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "normal drain"));
    await waitFor(() => ledgerEvents(ledger).some((event) => event.event === "send_started"), "drain request accepted by fake SDK");
    gateway.signal("SIGTERM");
    gateway.signal("SIGINT");
    const response = await pending;
    assert.equal(response.status, 200);
    const exit = await gateway.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    const row = latestRequestLog(gateway);
    assert.equal(row.http_status, 200);
  } finally {
    await gateway.stop();
  }
});

test("SIGTERM forces an unresponsive run to stop at the shutdown bound", { timeout: 30_000 }, async (context) => {
  const ledgerDir = makeTempDir(context, "cursor-api-shutdown-ledger-");
  const ledger = join(ledgerDir, "events.jsonl");
  const gateway = await startFakeGateway(
    { SHUTDOWN_TIMEOUT_MS: "150", FAKE_SDK_LEDGER: ledger },
    { keyPolicy: { quota_tokens: 100_000 } },
  );
  try {
    const pending = post(gateway, "/v1/chat/completions", bodyFor("/v1/chat/completions", false, "NEVER_SETTLE"));
    await waitFor(() => ledgerEvents(ledger).some((event) => event.event === "send_started"), "forced-shutdown request accepted by fake SDK");
    gateway.signal("SIGTERM");
    await pending.catch(() => undefined);
    const exit = await gateway.waitForExit();
    assert.notEqual(exit.code, 0);
    assert.match(gateway.output(), /forced/);
    assert.match(gateway.output(), /"unsettled":true/);
  } finally {
    await gateway.stop();
  }
});
