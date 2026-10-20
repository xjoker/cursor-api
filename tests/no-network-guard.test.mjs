// SAF-102: the suite runs with a no-network guard (scripts/run-tests.mjs). These checks make sure
// the guard is really active here and in child processes, and that it blocks and records.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const guardUrl = pathToFileURL(join(import.meta.dirname, "fixtures", "no-network.mjs")).href;

test("the network guard is preloaded into this test process", { skip: process.env.CURSOR_API_TEST_ALLOW_NETWORK === "1" }, () => {
  assert.equal(net.Socket.prototype.connect[Symbol.for("cursor-api.netguard")], true, "run tests via `npm test` (scripts/run-tests.mjs)");
  assert.match(process.env.NODE_OPTIONS ?? "", /no-network\.mjs/);
});

test("the guard blocks and records non-loopback connections (fetch, net, tls) but allows loopback", () => {
  const log = join(mkdtempSync(join(tmpdir(), "netguard-test-")), "blocked.log");
  // 192.0.2.1 / 198.51.100.1 are TEST-NET addresses: unroutable even if the guard were broken.
  const script = `
    import net from "node:net";
    import tls from "node:tls";
    const results = {};
    try { await fetch("http://192.0.2.1:80/"); results.fetch = "connected"; } catch (e) { results.fetch = e.cause?.code ?? e.code ?? String(e); }
    results.net = await new Promise((r) => net.connect(9, "198.51.100.1").on("error", (e) => r(e.code)).on("connect", () => r("connected")));
    results.tls = await new Promise((r) => tls.connect({ host: "198.51.100.2", port: 443 }).on("error", (e) => r(e.code)).on("secureConnect", () => r("connected")));
    const server = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    results.loopback = await new Promise((r) => net.connect(server.address().port, "127.0.0.1").on("connect", function () { this.destroy(); r("connected"); }).on("error", (e) => r(e.code)));
    server.close();
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ["--import", guardUrl, "--input-type=module", "-e", script], {
    env: { ...process.env, NODE_OPTIONS: "", CURSOR_API_NETGUARD_LOG: log },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").pop()), {
    fetch: "ENETGUARD",
    net: "ENETGUARD",
    tls: "ENETGUARD",
    loopback: "connected",
  });
  const blocked = readFileSync(log, "utf8");
  for (const host of ["192.0.2.1:80", "198.51.100.1:9", "198.51.100.2:443"]) assert.match(blocked, new RegExp(host.replaceAll(".", "\\.")));
});

test("loopback detection", async () => {
  const { isLoopback } = await import(guardUrl);
  for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0"]) assert.equal(isLoopback(host), true, host);
  for (const host of ["api.cursor.com", "api2.cursor.sh", "10.0.0.1", "192.168.1.1", "8.8.8.8", "::ffff:8.8.8.8", "127.example.com"]) assert.equal(isLoopback(host), false, host);
});
