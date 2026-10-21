import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeGateway } from "./fixtures/gateway-harness.mjs";

const ADMIN_HEADERS = { authorization: "Bearer it-admin-key" };
const ADMIN_JSON_HEADERS = {
  ...ADMIN_HEADERS,
  "content-type": "application/json",
};

function sleep(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function adminKeys(gateway) {
  const response = await fetch(`${gateway.baseUrl}/admin/api/keys`, { headers: ADMIN_HEADERS });
  assert.equal(response.status, 200);
  return (await response.json()).keys;
}

async function openSlowAdminRequest(gateway, method, pathname, body, splitAt) {
  const payload = Buffer.from(JSON.stringify(body));
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(new URL(pathname, gateway.baseUrl), {
      method,
      headers: { ...ADMIN_JSON_HEADERS, connection: "keep-alive", "content-length": String(payload.length) },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode, headers: incoming.headers, body: text, json: JSON.parse(text) });
      });
    });
    request.once("error", reject);
    request.setTimeout(3_000, () => request.destroy(new Error("timed out waiting for HTTP response")));
  }).finally(() => request.setTimeout(0));
  // Disconnect and shutdown cases intentionally allow the response to reject before it is awaited.
  void response.catch(() => undefined);
  const socketReady = once(request, "socket");
  request.write(payload.subarray(0, splitAt));
  const [socket] = await socketReady;
  if (socket.connecting) await once(socket, "connect");
  return {
    socket,
    response,
    sendTail() {
      if (!request.destroyed) request.end(payload.subarray(splitAt));
    },
  };
}

test("slow admin POST and PATCH time out without mutation after a late body tail", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ADMIN_REQUEST_TIMEOUT_MS: "120" });
  try {
    const post = await openSlowAdminRequest(gateway, "POST", "/admin/api/keys", { name: "late-post" }, 8);
    const postResponse = await post.response;
    assert.equal(postResponse.status, 504);
    assert.equal(postResponse.json?.code, "request_timeout");
    assert.equal(postResponse.headers.connection, "close");
    post.sendTail();
    await sleep(150);
    assert.equal((await adminKeys(gateway)).some((key) => key.name === "late-post"), false);
    post.socket.destroy();

    const patch = await openSlowAdminRequest(gateway, "PATCH", "/admin/api/keys/it-key", { name: "late-patch" }, 8);
    const patchResponse = await patch.response;
    assert.equal(patchResponse.status, 504);
    assert.equal(patchResponse.json?.code, "request_timeout");
    assert.equal(patchResponse.headers.connection, "close");
    patch.sendTail();
    await sleep(150);
    assert.equal((await adminKeys(gateway)).some((key) => key.name === "late-patch"), false);
    assert.equal((await adminKeys(gateway)).find((key) => key.id === "it-key")?.name, "integration");
    patch.socket.destroy();
  } finally {
    await gateway.stop();
  }
});

test("disconnecting a slow admin write leaves the database unchanged", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ADMIN_REQUEST_TIMEOUT_MS: "500" });
  let request;
  let responseSettled;
  try {
    request = await openSlowAdminRequest(gateway, "POST", "/admin/api/keys", { name: "disconnected" }, 8);
    responseSettled = request.response.catch(() => undefined);
    request.socket.destroy();
    await responseSettled;
    await sleep(150);
    assert.equal((await adminKeys(gateway)).some((key) => key.name === "disconnected"), false);
  } finally {
    request?.socket.destroy();
    if (responseSettled) await responseSettled;
    await gateway.stop();
  }
});

test("SIGTERM aborts a slow admin body before database close", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ADMIN_REQUEST_TIMEOUT_MS: "5000", SHUTDOWN_TIMEOUT_MS: "200" });
  let request;
  let responseSettled;
  try {
    request = await openSlowAdminRequest(gateway, "POST", "/admin/api/keys", { name: "shutdown-late" }, 8);
    responseSettled = request.response.catch(() => undefined);
    const started = Date.now();
    gateway.signal("SIGTERM");
    const exit = await gateway.waitForExit(4_000);
    assert.ok(exit.code === 0 || exit.code === 1, `unexpected exit code: ${String(exit.code)}`);
    assert.ok(Date.now() - started < 3_500, "SIGTERM waited beyond the bounded shutdown window");
    if (exit.code !== 0) assert.match(gateway.output(), /gateway shutdown forced/);
    assert.doesNotMatch(gateway.output(), /database is closed|SQLITE_MISUSE/);

    const db = new DatabaseSync(join(gateway.dataDir, "cursor-api.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE name = 'shutdown-late'").get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    request?.socket.destroy();
    if (responseSettled) await responseSettled;
    await gateway.stop();
  }
});

test("admin write auth, normal writes, delete and body-size limits remain intact", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway({ ADMIN_REQUEST_TIMEOUT_MS: "150" });
  try {
    const unauthorized = await fetch(`${gateway.baseUrl}/admin/api/keys`, {
      method: "POST",
      headers: { ...ADMIN_JSON_HEADERS, authorization: "Bearer wrong-admin-key" },
      body: JSON.stringify({ name: "unauthorized" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).code, "authentication_error");

    const createdResponse = await fetch(`${gateway.baseUrl}/admin/api/keys`, {
      method: "POST",
      headers: ADMIN_JSON_HEADERS,
      body: JSON.stringify({ name: "normal-admin-write" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const tooLarge = await fetch(`${gateway.baseUrl}/admin/api/keys`, {
      method: "POST",
      headers: ADMIN_JSON_HEADERS,
      body: JSON.stringify({ name: "x".repeat(4_194_300) }),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.headers.get("connection"), "close", "oversized body must not keep an incomplete upload alive");
    assert.equal((await tooLarge.json()).code, "payload_too_large");

    const deleted = await fetch(`${gateway.baseUrl}/admin/api/keys/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).id, created.id);
  } finally {
    await gateway.stop();
  }
});
