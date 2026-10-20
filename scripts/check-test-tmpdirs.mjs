#!/usr/bin/env node
// Regression check for leaked test temp directories: runs the test suite with TMPDIR pointed at a
// fresh private directory, then fails if any cursor-api-* entry is left behind in it.
//
//   npm run build && node scripts/check-test-tmpdirs.mjs [--exclude <substring>]... [--keep]
//
// --exclude drops test files whose path contains the substring (e.g. --exclude http-smoke for an
// offline run). --keep leaves the private TMPDIR in place for inspection.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const excludes = [];
let keep = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--exclude" && args[i + 1]) excludes.push(args[(i += 1)]);
  else if (args[i] === "--keep") keep = true;
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
}

const files = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => join("tests", name))
  .filter((file) => !excludes.some((pattern) => file.includes(pattern)))
  .sort();

const privateTmp = mkdtempSync(join(tmpdir(), "test-tmpdir-check-"));
const run = spawnSync(process.execPath, [join(root, "scripts", "run-tests.mjs"), ...files], {
  cwd: root,
  env: { ...process.env, CURSOR_API_TEST_TMPDIR: privateTmp, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp },
  stdio: "inherit",
});

const leftovers = readdirSync(privateTmp).sort();
const leaked = leftovers.filter((name) => name.startsWith("cursor-api-"));
console.log(`\n[tmpdir-check] private TMPDIR: ${privateTmp}`);
console.log(`[tmpdir-check] test files: ${files.length}, test exit status: ${run.status ?? run.signal}`);
console.log(`[tmpdir-check] leftover cursor-api-* entries: ${leaked.length}`);
for (const name of leaked) console.log(`  ${name}`);
const other = leftovers.filter((name) => !name.startsWith("cursor-api-"));
if (other.length > 0) console.log(`[tmpdir-check] other leftover entries (not failing): ${other.join(", ")}`);

if (!keep) rmSync(privateTmp, { recursive: true, force: true });
process.exit(run.status !== 0 ? (run.status ?? 1) : leaked.length > 0 ? 1 : 0);
