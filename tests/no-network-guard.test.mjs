// SAF-102: the suite runs with a no-network guard (scripts/run-tests.mjs). These checks make sure
// the guard is really active here and in child processes, that it blocks and records every path
// (TCP/TLS/HTTP(S)/HTTP2/fetch, DNS, UDP, hostnames resolving off loopback), and that the runner
// fails the run on a recorded attempt even when the test itself swallowed the error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const guardUrl = pathToFileURL(join(import.meta.dirname, "fixtures", "no-network.mjs")).href;
/** Inherited NODE_OPTIONS without this guard (other preloads, e.g. an outer sandbox, stay). */
const outerNodeOptions = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((part) => part !== "" && !part.includes("no-network.mjs")).join(" ");

/** A nested `node --test` must not think it runs inside this test file (it would skip its files). */
function withoutTestContext() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function withTempDir(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the network guard is preloaded into this test process", { skip: process.env.CURSOR_API_TEST_ALLOW_NETWORK === "1" }, () => {
  assert.equal(net.Socket.prototype.connect[Symbol.for("cursor-api.netguard")], true, "run tests via `npm test` (scripts/run-tests.mjs)");
  assert.match(process.env.NODE_OPTIONS ?? "", /no-network\.mjs/);
});

test("the guard blocks and records every outbound path but allows loopback", () => {
  withTempDir("netguard-test-", (dir) => {
    const log = join(dir, "blocked.log");
    // 192.0.2.x / 198.51.100.x / 203.0.113.x are TEST-NET addresses; *.invalid never resolves.
    const script = `
      import dgram from "node:dgram";
      import dns from "node:dns";
      import { lookup as namedLookup } from "node:dns";
      import http from "node:http";
      import http2 from "node:http2";
      import https from "node:https";
      import net from "node:net";
      import tls from "node:tls";
      const code = (e) => e?.cause?.code ?? e?.code ?? String(e);
      const results = {};
      try { await fetch("http://192.0.2.1:80/"); results.fetch = "connected"; } catch (e) { results.fetch = code(e); }
      results.net = await new Promise((r) => net.connect(9, "198.51.100.1").on("error", (e) => r(code(e))).on("connect", () => r("connected")));
      results.tls = await new Promise((r) => tls.connect({ host: "198.51.100.2", port: 443 }).on("error", (e) => r(code(e))).on("secureConnect", () => r("connected")));
      results.httpGet = await new Promise((r) => http.get("http://192.0.2.10:81/", () => r("connected")).on("error", (e) => r(code(e))));
      results.httpsGet = await new Promise((r) => https.get("https://192.0.2.11:444/", () => r("connected")).on("error", (e) => r(code(e))));
      results.httpRequest = await new Promise((r) => { const q = http.request({ host: "192.0.2.12", port: 82 }, () => r("connected")); q.on("error", (e) => r(code(e))); q.end(); });
      // http2 emits "connect" for the session object even on a socket that never connected.
      results.http2 = await new Promise((r) => { const s = http2.connect("http://192.0.2.13:83"); s.on("error", (e) => r(code(e))); s.on("connect", () => { if (s.socket?.remoteAddress) r("connected"); }); });
      results.dnsLookup = await new Promise((r) => dns.lookup("probe.example.invalid", (e) => r(e ? code(e) : "resolved")));
      results.dnsNamedImport = await new Promise((r) => namedLookup("probe2.example.invalid", (e) => r(e ? code(e) : "resolved")));
      results.dnsResolve = await new Promise((r) => dns.resolve4("probe3.example.invalid", (e) => r(e ? code(e) : "resolved")));
      try { await dns.promises.lookup("probe4.example.invalid"); results.dnsPromises = "resolved"; } catch (e) { results.dnsPromises = code(e); }
      try { await new dns.promises.Resolver().resolve4("probe5.example.invalid"); results.dnsResolver = "resolved"; } catch (e) { results.dnsResolver = code(e); }
      const udp = dgram.createSocket("udp4");
      results.udpSend = await new Promise((r) => udp.send("x", 53, "203.0.113.1", (e) => r(e ? code(e) : "sent")));
      udp.close();
      // "localhost" whose lookup resolves to a public address: the resolved address is checked.
      const evilLookup = (host, options, cb) => (options.all ? cb(null, [{ address: "203.0.113.2", family: 4 }]) : cb(null, "203.0.113.2", 4));
      results.resolvedCheck = await new Promise((r) => net.connect({ host: "localhost", port: 9, lookup: evilLookup }).on("error", (e) => r(code(e))).on("connect", () => r("connected")));
      results.dotLocalhost = await new Promise((r) => net.connect(9, "api.localhost").on("error", (e) => r(code(e))).on("connect", () => r("connected")));
      const server = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const port = server.address().port;
      results.loopback = await new Promise((r) => net.connect(port, "127.0.0.1").on("connect", function () { this.destroy(); r("connected"); }).on("error", (e) => r(code(e))));
      results.localhost = await new Promise((r) => net.connect({ host: "localhost", port, family: 4 }).on("connect", function () { this.destroy(); r("connected"); }).on("error", (e) => r(code(e))));
      server.close();
      console.log(JSON.stringify(results));
    `;
    const child = spawnSync(process.execPath, ["--import", guardUrl, "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_OPTIONS: outerNodeOptions, CURSOR_API_NETGUARD_LOG: log },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout.trim().split("\n").pop());
    const blockedPaths = ["fetch", "net", "tls", "httpGet", "httpsGet", "httpRequest", "http2", "dnsLookup", "dnsNamedImport", "dnsResolve", "dnsPromises", "dnsResolver", "udpSend", "resolvedCheck", "dotLocalhost"];
    for (const path of blockedPaths) assert.equal(results[path], "ENETGUARD", `${path}: ${String(results[path])}`);
    assert.equal(results.loopback, "connected");
    assert.equal(results.localhost, "connected");
    const blocked = readFileSync(log, "utf8");
    for (const where of ["192.0.2.1:80", "198.51.100.1:9", "198.51.100.2:443", "192.0.2.10:81", "192.0.2.11:444", "192.0.2.12:82", "192.0.2.13:83", "probe.example.invalid", "probe2.example.invalid", "probe3.example.invalid", "probe4.example.invalid", "probe5.example.invalid", "203.0.113.1:53", "localhost->203.0.113.2:9", "api.localhost:9"]) {
      assert.ok(blocked.includes(where), `recorded ${where}`);
    }
  });
});

test("the runner fails the run when a test swallowed a blocked connection (and passes a clean one)", { timeout: 60_000, skip: process.env.CURSOR_API_TEST_ALLOW_NETWORK === "1" }, () => {
  withTempDir("netguard-runner-", (dir) => {
    const swallowed = join(dir, "swallowed.test.mjs");
    writeFileSync(swallowed, `
      import net from "node:net";
      import { test } from "node:test";
      test("swallows a blocked connection", async () => {
        await new Promise((resolve) => net.connect(9, "192.0.2.77").on("error", resolve).on("connect", resolve));
      });
    `);
    const clean = join(dir, "clean.test.mjs");
    writeFileSync(clean, `import { test } from "node:test"; test("ok", () => {});`);
    const run = (file) =>
      spawnSync(process.execPath, [join(root, "scripts", "run-tests.mjs"), file], {
        cwd: root,
        env: { ...withoutTestContext(), NODE_OPTIONS: outerNodeOptions, CURSOR_API_NETGUARD_LOG: "" },
        encoding: "utf8",
      });
    const bad = run(swallowed);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /no-network guard: tests attempted outbound connections/);
    assert.match(bad.stderr, /192\.0\.2\.77:9/);
    const good = run(clean);
    assert.equal(good.status, 0, good.stdout + good.stderr);
  });
});

test("loopback detection", async () => {
  const { isLoopback, isLoopbackName } = await import(guardUrl);
  for (const host of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0"]) assert.equal(isLoopback(host), true, host);
  for (const host of ["localhost", "api.localhost", "api.cursor.com", "api2.cursor.sh", "10.0.0.1", "192.168.1.1", "8.8.8.8", "::ffff:8.8.8.8", "127.example.com"]) {
    assert.equal(isLoopback(host), false, host);
  }
  assert.equal(isLoopbackName("localhost"), true);
  assert.equal(isLoopbackName("api.localhost"), false, "no *.localhost shortcut");
});
