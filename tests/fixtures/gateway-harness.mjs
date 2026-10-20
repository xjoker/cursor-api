// Starts dist/index.js against the fake Cursor SDK with a throwaway data dir and client key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLIENT_KEY = "cgk_integration_test_key";

/** `options.keyPolicy` seeds per-key policy columns (allowed_models, quota_requests, ...) on the client key. */
export async function startFakeGateway(extraEnv = {}, options = {}) {
  const { digestClientKey } = await import("../../dist/auth.js");
  const { insertApiKey, openDb } = await import("../../dist/db.js");
  const dataDir = mkdtempSync(join(tmpdir(), "cursor-api-it-"));
  const pepper = "it-pepper";
  const now = new Date().toISOString();
  const db = openDb(dataDir, { retentionDays: 30, maxRows: 1000, maxDetailBytes: 1_048_576 });
  insertApiKey(db, {
    id: "it-key",
    name: "integration",
    key_prefix: "cgk_integra",
    key_digest: digestClientKey(pepper, CLIENT_KEY),
    created_at: now,
    updated_at: now,
    ...(options.keyPolicy ?? {}),
  });
  db.close();

  const port = await reservePort();
  const root = join(import.meta.dirname, "..", "..");
  const child = spawn(
    process.execPath,
    ["--import", join(import.meta.dirname, "register-fake-sdk.mjs"), "dist/index.js"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        CURSOR_WORKSPACE: join(dataDir, "workspace"),
        CURSOR_API_KEY: "good-key",
        ADMIN_ACCESS_KEY: "it-admin-key",
        API_KEY_PEPPER: pepper,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(port),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const started = Date.now();
  while (!output.includes('"message":"gateway listening"')) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`gateway exited before ready:\n${output}`);
    }
    if (Date.now() - started > 5_000) throw new Error(`gateway did not become ready:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

/** Parses an SSE body into [{event, data}] frames. */
export function parseSse(text) {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      const raw = data.join("\n");
      let parsed = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // `[DONE]` and other raw frames stay strings.
      }
      return { event, data: parsed };
    });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
