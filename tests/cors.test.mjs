import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { corsHeaders } from "../dist/http.js";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

test("CORS allows wildcard, exact origins, or no browser origins", () => {
  const req = { headers: { origin: "https://client.example" } };
  assert.equal(corsHeaders(req)["access-control-allow-origin"], "*");
  assert.equal(corsHeaders(req, ["https://client.example"])["access-control-allow-origin"], req.headers.origin);
  const denied = corsHeaders(req, ["https://other.example"]);
  assert.equal(denied["access-control-allow-origin"], undefined);
  assert.equal(denied.vary, "Origin");
  assert.deepEqual(corsHeaders(req, []), {});
});

test("CORS config validates origins and respects an explicitly empty environment override", (context) => {
  const root = makeTempDir(context, "cursor-api-cors-");
  mkdirSync(join(root, "data/config"), { recursive: true });
  writeFileSync(join(root, "data/config/gateway.toml"), [
    'cursor_api_key = "test"', 'admin_access_key = "test"', 'api_key_pepper = "test"',
    'cors_allow_origins = "https://client.example, http://localhost:5173"',
  ].join("\n"));
  assert.deepEqual(loadConfig({}, root).corsAllowOrigins, ["https://client.example", "http://localhost:5173"]);
  assert.deepEqual(loadConfig({ CORS_ALLOW_ORIGINS: "" }, root).corsAllowOrigins, []);
  assert.deepEqual(loadConfig({ CORS_ALLOW_ORIGINS: "*" }, root).corsAllowOrigins, ["*"]);
  for (const value of ["https://client.example/path", "null", "https://*.example", "*,https://client.example"]) {
    assert.throws(() => loadConfig({ CORS_ALLOW_ORIGINS: value }, root), /CORS_ALLOW_ORIGINS/);
  }
});

test("CORS policy applies to preflight, API success, and API errors", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ CORS_ALLOW_ORIGINS: "https://client.example" });
  try {
    for (const origin of ["https://client.example", "https://untrusted.example"]) {
      const headers = { origin, authorization: `Bearer ${CLIENT_KEY}` };
      for (const [path, options] of [
        ["/v1/not-found", { headers }],
        ["/v1/chat/completions", { method: "OPTIONS", headers }],
        ["/v1/models", { headers }],
        ["/v1/models", { headers: { origin } }],
        ["/v1/responses", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }],
      ]) {
        const res = await fetch(`${gateway.baseUrl}${path}`, options);
        assert.equal(res.headers.get("access-control-allow-origin"), origin === "https://client.example" ? origin : null);
        assert.equal(res.headers.get("vary"), "Origin");
        await res.text();
      }
    }
  } finally {
    await gateway.stop();
  }
});
