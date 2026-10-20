import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

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
    });

    const serialized = JSON.stringify(overview);
    for (const secret of ["good-key", "it-admin-key", "it-pepper", CLIENT_KEY, gateway.dataDir, `${gateway.dataDir}/workspace`]) {
      assert.equal(serialized.includes(secret), false, "overview contains a credential or private path");
    }
  } finally {
    await gateway.stop();
  }
});
