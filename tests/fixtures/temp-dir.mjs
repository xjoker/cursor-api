// Per-test temp directories under os.tmpdir() that are removed again when the owning test ends,
// so repeated test runs do not pile up cursor-api-* directories in /tmp.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates `<tmpdir>/<prefix>XXXXXX` and registers its removal with the node:test `context`.
 * `context.after` runs once the test body has settled (including its `finally` blocks), so a
 * child process the test spawned and awaited has exited before the directory is deleted.
 */
export function makeTempDir(context, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => removeTempDir(dir));
  return dir;
}

/** Recursively deletes a temp directory; a missing directory is not an error. */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
