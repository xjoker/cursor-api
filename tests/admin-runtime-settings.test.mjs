import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

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

function configEnv(extra = {}) {
  return {
    DATA_DIR: "data",
    CURSOR_API_KEY: "key",
    ADMIN_ACCESS_KEY: "admin",
    API_KEY_PEPPER: "pepper",
    ...extra,
  };
}

test("admin write timeout config uses env over TOML and defaults to a bounded positive value", (context) => {
  const root = makeTempDir(context, "cursor-api-admin-timeout-config-");
  writeGatewayConfig(root, ["admin_request_timeout_ms = 1234"]);

  assert.equal(loadConfig(configEnv(), root).adminRequestTimeoutMs, 1234);
  assert.equal(
    loadConfig(configEnv({ ADMIN_REQUEST_TIMEOUT_MS: "2345" }), root).adminRequestTimeoutMs,
    2345,
  );

  const defaultsRoot = makeTempDir(context, "cursor-api-admin-timeout-default-");
  writeGatewayConfig(defaultsRoot);
  assert.equal(loadConfig(configEnv(), defaultsRoot).adminRequestTimeoutMs, 10_000);

  for (const value of ["0", "-1", "300001", "1.5"]) {
    assert.throws(
      () => loadConfig(configEnv({ ADMIN_REQUEST_TIMEOUT_MS: value }), defaultsRoot),
      /ADMIN_REQUEST_TIMEOUT_MS/,
    );
  }
});

test("admin write timeout rejects invalid TOML scalars and honors an environment override", (context) => {
  const root = makeTempDir(context, "cursor-api-admin-timeout-invalid-");
  for (const value of ["true", "false", '"invalid"', "1.5", "0", "300001"]) {
    writeGatewayConfig(root, [`admin_request_timeout_ms = ${value}`]);
    assert.throws(() => loadConfig(configEnv(), root), /admin_request_timeout_ms/);
    assert.equal(loadConfig(configEnv({ ADMIN_REQUEST_TIMEOUT_MS: "2345" }), root).adminRequestTimeoutMs, 2345);
  }
});

test("admin overview exposes the effective non-sensitive runtime settings", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({
    RATE_LIMIT_PER_KEY: "7",
    ALLOW_MAX_MODE: "false",
    ENFORCE_OUTPUT_LIMITS: "true",
    HISTORY_RESUME: "true",
    IGNORE_SAMPLING_PARAMS: "true",
    SSE_KEEPALIVE_MS: "2345",
    MAX_LIVE_SESSIONS: "17",
    CONVERSATION_TTL_DAYS: "9",
    REQUEST_TIMEOUT_MS: "1234",
    SHUTDOWN_TIMEOUT_MS: "4321",
  });
  try {
    const unauthenticated = await fetch(`${gateway.baseUrl}/admin/api/overview`);
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${gateway.baseUrl}/admin/api/overview`, {
      headers: { authorization: "Bearer it-admin-key" },
    });
    assert.equal(response.status, 200);
    const overview = await response.json();

    assert.ok(Object.hasOwn(overview, "version"));
    assert.ok(Object.hasOwn(overview, "git_commit"));
    assert.ok(Object.hasOwn(overview, "schema_version"));
    assert.deepEqual(overview.settings, {
      rate_limit_per_key: 7,
      allow_max_mode: false,
      enforce_output_limits: true,
      history_resume: true,
      ignore_sampling_params: true,
      sse_keepalive_ms: 2345,
      max_live_sessions: 17,
      conversation_ttl_days: 9,
      request_timeout_ms: 1234,
      admin_request_timeout_ms: 10000,
      shutdown_timeout_ms: 4321,
    });

    const serialized = JSON.stringify(overview);
    for (const secret of ["good-key", "it-admin-key", "it-pepper", CLIENT_KEY, gateway.dataDir, `${gateway.dataDir}/workspace`]) {
      assert.equal(serialized.includes(secret), false, "overview contains a credential or private path");
    }
  } finally {
    await gateway.stop();
  }
});
