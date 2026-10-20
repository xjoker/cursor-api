#!/usr/bin/env node
// `npm test` entry (SAF-102): runs node --test with a no-network guard preloaded into every test
// process and every child process (gateway instances spawned by tests inherit NODE_OPTIONS).
// Fails the run if anything tried to reach a non-loopback host, even if the error was handled.
//
//   node scripts/run-tests.mjs                 # all tests/*.test.mjs
//   node scripts/run-tests.mjs tests/x.test.mjs
//   CURSOR_API_TEST_ALLOW_NETWORK=1 ...        # explicit opt-out (no test needs it today)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(join(root, "tests"))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => join("tests", name));

const env = { ...process.env };
const allowNetwork = env.CURSOR_API_TEST_ALLOW_NETWORK === "1";
const logDir = mkdtempSync(join(tmpdir(), "cursor-api-netguard-"));
const log = join(logDir, "blocked.log");
// Every temp dir the tests create lands in this run-scoped TMPDIR, removed when the run ends.
env.TMPDIR = join(logDir, "tmp");
mkdirSync(env.TMPDIR);
if (!allowNetwork) {
  const guard = pathToFileURL(join(root, "tests", "fixtures", "no-network.mjs")).href;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${guard}`.trim();
  env.CURSOR_API_NETGUARD_LOG = log;
} else {
  process.stderr.write("CURSOR_API_TEST_ALLOW_NETWORK=1: network guard disabled\n");
}

const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, env, stdio: "inherit" });
let status = result.status ?? 1;
if (existsSync(log)) {
  const blocked = readFileSync(log, "utf8").trim();
  if (blocked !== "") {
    process.stderr.write(`\nno-network guard: tests attempted outbound connections:\n${blocked}\n`);
    status = 1;
  }
}
rmSync(logDir, { recursive: true, force: true });
process.exit(status);
