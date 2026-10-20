import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { parseModelAliases, resolveModelAlias } from "../dist/model-alias.js";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

test("model_aliases parse globs, keep order, and reject malformed entries", (context) => {
  const aliases = parseModelAliases("client-fast-*=fast-model; client-*=composer-2.5\nexact=other");
  assert.equal(resolveModelAlias(aliases, "client-fast-1"), "fast-model");
  assert.equal(resolveModelAlias(aliases, "CLIENT-GENERAL-1"), "composer-2.5");
  assert.equal(resolveModelAlias(aliases, "exact"), "other");
  assert.equal(resolveModelAlias(aliases, "exactly"), "exactly");
  assert.equal(resolveModelAlias(aliases, "gpt-x.1"), "gpt-x.1");
  assert.equal(resolveModelAlias(parseModelAliases("a.b=c"), "aXb"), "aXb");
  assert.deepEqual(parseModelAliases(""), []);
  for (const bad of ["nope", "=x", "a=", "a=b*"]) {
    assert.throws(() => parseModelAliases(bad), /model_aliases/);
  }

  const root = makeTempDir(context, "cursor-api-model-alias-");
  mkdirSync(join(root, "data", "config"), { recursive: true });
  writeFileSync(
    join(root, "data", "config", "gateway.toml"),
    ['cursor_api_key = "c"', 'admin_access_key = "a"', 'api_key_pepper = "p"', 'model_aliases = "client-*=composer-2.5"', ""].join("\n"),
  );
  const cfg = loadConfig({ DATA_DIR: "data" }, root);
  assert.equal(resolveModelAlias(cfg.modelAliases, "client-general-1"), "composer-2.5");
  assert.throws(() => loadConfig({ DATA_DIR: "data", MODEL_ALIASES: "broken" }, root), /model_aliases/);
});

