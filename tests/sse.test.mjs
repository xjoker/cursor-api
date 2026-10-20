import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { beginSse, configureSse, writeSse } from "../dist/http.js";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("sse_keepalive_ms defaults to 15s, accepts 0 to disable, and is bounded", (context) => {
  const root = makeTempDir(context, "cursor-api-sse-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  const file = join(root, "data", "config", "gateway.toml");
  const base = ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"'];
  writeFileSync(file, [...base, ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).sseKeepaliveMs, 15_000);
  writeFileSync(file, [...base, "sse_keepalive_ms = 0", ""].join("\n"));
  assert.equal(loadConfig({ DATA_DIR: "data" }, root).sseKeepaliveMs, 0);
  assert.equal(loadConfig({ DATA_DIR: "data", SSE_KEEPALIVE_MS: "5000" }, root).sseKeepaliveMs, 5000);
  assert.throws(() => loadConfig({ DATA_DIR: "data", SSE_KEEPALIVE_MS: "10" }, root), /SSE_KEEPALIVE_MS/);
  assert.throws(() => loadConfig({ DATA_DIR: "data", SSE_KEEPALIVE_MS: "-1" }, root), /SSE_KEEPALIVE_MS/);
});

test("beginSse flushes headers immediately and sends comment heartbeats while idle", async () => {
  await withServer(async (_req, res) => {
    beginSse(res, "req_1", {}, { keepaliveMs: 40 });
    await sleep(230);
    await writeSse(res, { hello: "world" });
    await writeSse(res, "[DONE]");
    res.end();
  }, async (baseUrl) => {
    const started = Date.now();
    const response = await fetch(baseUrl);
    assert.ok(Date.now() - started < 200, "headers should arrive before the first data frame");
    assert.equal(response.headers.get("x-request-id"), "req_1");
    const body = await response.text();
    const beats = body.split(": keepalive\n\n").length - 1;
    assert.ok(beats >= 3, `expected heartbeats, got ${String(beats)} in ${JSON.stringify(body)}`);
    assert.ok(body.endsWith('data: {"hello":"world"}\n\ndata: [DONE]\n\n'));
    // Every frame stays a complete SSE event.
    for (const frame of body.split("\n\n").filter(Boolean)) {
      assert.match(frame, /^(: keepalive|data: .+)$/);
    }
  });
});

test("heartbeats stop when the stream ends or the client disconnects, and 0 disables them", async () => {
  let closedRes;
  await withServer((_req, res) => {
    closedRes = res;
    beginSse(res, "req_2", {}, { keepaliveMs: 20 });
  }, async (baseUrl) => {
    const controller = new AbortController();
    const response = await fetch(baseUrl, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await sleep(80);
    assert.equal(closedRes.destroyed || closedRes.closed, true);
    const writes = [];
    const original = closedRes.write.bind(closedRes);
    closedRes.write = (...args) => {
      writes.push(args[0]);
      return original(...args);
    };
    await sleep(80);
    assert.deepEqual(writes, []);
  });

  configureSse({ keepaliveMs: 0 });
  try {
    await withServer(async (_req, res) => {
      beginSse(res, "req_3");
      await sleep(120);
      await writeSse(res, "[DONE]");
      res.end();
    }, async (baseUrl) => {
      assert.equal(await (await fetch(baseUrl)).text(), "data: [DONE]\n\n");
    });
  } finally {
    configureSse({ keepaliveMs: 15_000 });
  }
});
