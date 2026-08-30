import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("HTTP smoke covers health and client/admin authentication boundaries", { timeout: 10_000 }, async () => {
  const { digestClientKey } = await import("../dist/auth.js");
  const { disableApiKey, insertApiKey, openDb } = await import("../dist/db.js");
  const dataDir = mkdtempSync(join(tmpdir(), "cursor-api-http-"));
  const workspaceDir = join(dataDir, "workspace");
  const pepper = "test-pepper";
  const disabledKey = "cgk_disabled_test_key";
  const now = new Date().toISOString();
  const db = openDb(dataDir, { retentionDays: 30, maxRows: 100, maxDetailBytes: 1_048_576 });
  insertApiKey(db, {
    id: "disabled-key",
    name: "disabled",
    key_prefix: "cgk_disabled",
    key_digest: digestClientKey(pepper, disabledKey),
    created_at: now,
    updated_at: now,
  });
  disableApiKey(db, "disabled-key");
  db.close();

  const port = await reservePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      CURSOR_WORKSPACE: workspaceDir,
      CURSOR_API_KEY: "test-cursor-key",
      ADMIN_ACCESS_KEY: "test-admin-key",
      API_KEY_PEPPER: pepper,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExited = once(child, "exit");
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    await waitForGateway(child, () => output);
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const missingClient = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(missingClient.status, 401);
    assert.equal((await missingClient.json()).error.code, "authentication_error");

    const disabledClient = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${disabledKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(disabledClient.status, 403);
    assert.equal((await disabledClient.json()).error.code, "permission_error");

    const badAdmin = await fetch(`${baseUrl}/admin/api/keys`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(badAdmin.status, 401);
    assert.equal((await badAdmin.json()).code, "authentication_error");

    const goodAdmin = await fetch(`${baseUrl}/admin/api/keys`, {
      headers: { authorization: "Bearer test-admin-key" },
    });
    assert.equal(goodAdmin.status, 200);
    assert.equal((await goodAdmin.json()).keys.length, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await childExited;
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForGateway(child, readOutput) {
  const started = Date.now();
  while (!readOutput().includes('"message":"gateway listening"')) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`gateway exited before ready:\n${readOutput()}`);
    }
    if (Date.now() - started > 5_000) {
      throw new Error(`gateway did not become ready:\n${readOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
