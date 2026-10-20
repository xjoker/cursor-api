import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

test("temp directory checks retain the offline guard and detect leaked directories", (context) => {
  const root = makeTempDir(context, "test-runner-integration-");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  for (const file of ["scripts/check-test-tmpdirs.mjs", "scripts/run-tests.mjs", "tests/fixtures/no-network.mjs"]) {
    copyFileSync(join(import.meta.dirname, "..", file), join(root, file));
  }
  const probe = join(root, "tests", "probe.test.mjs");
  writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { test } from 'node:test';
    test('guard active', () => assert.equal(net.Socket.prototype.connect[Symbol.for('cursor-api.netguard')], true));
  `);
  const env = { ...process.env, NODE_OPTIONS: "", CURSOR_API_NETGUARD_LOG: "" };
  delete env.NODE_TEST_CONTEXT;
  delete env.CURSOR_API_TEST_ALLOW_NETWORK;
  const run = () => spawnSync(process.execPath, [join(root, "scripts", "check-test-tmpdirs.mjs")], {
    cwd: root, env, encoding: "utf8", timeout: 15_000,
  });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  writeFileSync(probe, `
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { test } from 'node:test';
    test('leak', () => { mkdtempSync(join(tmpdir(), 'cursor-api-leaked-')); });
  `);
  const leaked = run();
  assert.equal(leaked.status, 1, leaked.stdout + leaked.stderr);
  assert.match(leaked.stdout, /leftover cursor-api-\* entries: 1/);
});
