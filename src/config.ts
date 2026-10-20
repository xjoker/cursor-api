import fs from "node:fs";
import path from "node:path";
import { logWarn } from "./log.js";
import type { AppConfig } from "./contracts.js";
import { parseModelAliases } from "./model-alias.js";

const MAX_BODY_BYTES = 4_194_304;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_DATA_DIR = "data";
const DEFAULT_LOG_RETENTION_DAYS = 7;
const DEFAULT_LOG_MAX_ROWS = 100_000;
const DEFAULT_LOG_DETAILED = false;
const DEFAULT_LOG_DETAILED_MAX_BYTES = 65_536;
const DEFAULT_LOG_MAX_DETAIL_BYTES = 268_435_456; // 256 MiB across all detail columns
const DEFAULT_PARK_TIMEOUT_MS = 300_000;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
const DEFAULT_AUTH_FAILURE_LIMIT = 20;
const DEFAULT_MAX_LIVE_SESSIONS = 256;
const DEFAULT_CONVERSATION_TTL_DAYS = 30;
const DEFAULT_CURSOR_KEY_COOLDOWN_MS = 60_000;
const CONFIG_FILE_NAME = "gateway.toml";

const EMPTY_CONFIG_TEMPLATE = `# cursor-api configuration (auto-created in container)
# Fill the three secrets below, then restart the gateway.

# host = "0.0.0.0"  # unset: Docker image default (GATEWAY_DEFAULT_HOST=0.0.0.0), else 127.0.0.1
port = 8787

cursor_api_key = ""
admin_access_key = ""
api_key_pepper = ""

# Extra Cursor keys for rotation / failover (comma-separated):
# cursor_api_keys = "key-2,key-3"
# cursor_key_cooldown_ms = 60000
# cursor_key_strategy = "round_robin"   # or "least_active"

# park_timeout_ms = 300000
# max_live_sessions = 256        # running + parked Cursor sessions kept in memory
# conversation_ttl_days = 30     # drop conversation_id mappings unused this long
# ignore_sampling_params = false  # drop unsupported Chat Completions sampling knobs
# enforce_output_limits = false  # true: enforce max_tokens / stop at the gateway (cut + cancel the run)
# allow_max_mode = true          # false: never run Cursor max-mode variants (pick non-max or reject)
# quota_cache_read_weight = 1.0  # 0..1: how much a cache-read token counts toward per-key token quotas
# sse_keepalive_ms = 15000       # 0 disables SSE comment heartbeats
# auth_failure_limit = 20        # failed auth attempts per address per minute; 0 = off
# cors_allow_origins = "*"       # comma-separated HTTP origins; empty disables CORS
# trusted_proxies = ""     # reverse proxy IPs/CIDRs whose X-Forwarded-For is trusted
# POST /v1/messages/count_tokens: "estimate" (rough local count) or "off" (404)
# anthropic_count_tokens = "off"
# Map client model names onto Cursor models (first match wins, * is a wildcard):
# model_aliases = "claude-opus-*=composer-2.5, claude-sonnet-*=composer-2.5, claude-haiku-*=composer-2.5"

[logs]
retention_days = 7
max_rows = 100000
detailed = false
# detailed_max_bytes = 65536
# max_detail_bytes = 268435456
`;

interface TomlTable {
  [key: string]: string | number | boolean | TomlTable;
}

export type ConfigWarning = (message: string, fields: Record<string, unknown>) => void;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  warn: ConfigWarning = logWarn,
): AppConfig {
  const dataDirHint = optionalTrimmed(env.DATA_DIR) ?? DEFAULT_DATA_DIR;
  const dataRoot = path.resolve(cwd, dataDirHint);
  const configDir = path.join(dataRoot, "config");
  const configFile = path.join(configDir, CONFIG_FILE_NAME);
  const production = optionalTrimmed(env.NODE_ENV) === "production";

  ensureConfigFile(configFile, production);
  const toml = readTomlFile(configFile);

  const dataDir = path.resolve(
    cwd,
    pickString(env.DATA_DIR, tomlString(toml, "data_dir")) ?? dataDirHint,
  );
  // Listen address priority: GATEWAY_HOST > gateway.toml host > GATEWAY_DEFAULT_HOST > 127.0.0.1.
  // The Docker image sets GATEWAY_DEFAULT_HOST=0.0.0.0, below the TOML, so a mounted config's host wins.
  const defaultHost = optionalTrimmed(env.GATEWAY_DEFAULT_HOST) ?? DEFAULT_HOST;
  warnIfHostOverridden(env, tomlString(toml, "host"), configFile, warn);

  return {
    corsAllowOrigins: parseCorsOrigins(env.CORS_ALLOW_ORIGINS ?? tomlString(toml, "cors_allow_origins") ?? "*"),
    ...cursorKeys(env, toml, configFile),
    adminAccessKey: requireSecret(
      env,
      "ADMIN_ACCESS_KEY",
      tomlString(toml, "admin_access_key"),
      configFile,
      "admin_access_key",
    ),
    apiKeyPepper: requireSecret(
      env,
      "API_KEY_PEPPER",
      tomlString(toml, "api_key_pepper"),
      configFile,
      "api_key_pepper",
    ),
    anthropicCountTokens: parseCountTokensMode(
      pickConfigured(env, "ANTHROPIC_COUNT_TOKENS", tomlString(toml, "anthropic_count_tokens"), "anthropic_count_tokens"),
    ),
    modelAliases: parseModelAliases(
      pickString(env.MODEL_ALIASES, tomlString(toml, "model_aliases")),
      "model_aliases",
    ),
    gatewayHost: pickString(env.GATEWAY_HOST, tomlString(toml, "host")) ?? defaultHost,
    gatewayPort: parsePositiveInt(
      pickConfigured(env, "GATEWAY_PORT", tomlString(toml, "port"), "port"),
      DEFAULT_PORT,
    ),
    dataDir,
    cursorWorkspace: path.resolve(
      cwd,
      pickString(env.CURSOR_WORKSPACE, tomlString(toml, "cursor_workspace")) ??
        path.join(dataDir, "workspace"),
    ),
    version: readVersion(cwd),
    gitCommit:
      pickString(env.GIT_COMMIT, undefined) ??
      pickString(env.SOURCE_COMMIT, undefined) ??
      readGitCommit(cwd) ??
      "unknown",
    maxBodyBytes: MAX_BODY_BYTES,
    logRetentionDays: parseBoundedInt(
      pickConfigured(env, "LOG_RETENTION_DAYS", intToString(tomlInt(toml, "retention_days")), "retention_days"),
      DEFAULT_LOG_RETENTION_DAYS,
      { min: 1, max: 3650 },
    ),
    logMaxRows: parseBoundedInt(
      pickConfigured(env, "LOG_MAX_ROWS", intToString(tomlInt(toml, "max_rows")), "max_rows"),
      DEFAULT_LOG_MAX_ROWS,
      { min: 1_000, max: 10_000_000 },
    ),
    logDetailed: parseBoolean(
      pickConfigured(env, "LOG_DETAILED", boolToString(tomlBool(toml, "detailed")), "detailed"),
      DEFAULT_LOG_DETAILED,
    ),
    logDetailedMaxBytes: parseBoundedInt(
      pickConfigured(
        env,
        "LOG_DETAILED_MAX_BYTES",
        intToString(tomlInt(toml, "detailed_max_bytes")),
        "detailed_max_bytes",
      ),
      DEFAULT_LOG_DETAILED_MAX_BYTES,
      { min: 4_096, max: 1_048_576 },
    ),
    logMaxDetailBytes: parseBoundedInt(
      pickConfigured(
        env,
        "LOG_MAX_DETAIL_BYTES",
        intToString(tomlInt(toml, "max_detail_bytes")),
        "max_detail_bytes",
      ),
      DEFAULT_LOG_MAX_DETAIL_BYTES,
      { min: 1_048_576, max: 10_737_418_240 },
    ),
    ignoreSamplingParams: parseBoolean(
      pickConfigured(env, "IGNORE_SAMPLING_PARAMS", boolToString(tomlBool(toml, "ignore_sampling_params")), "ignore_sampling_params"),
      false,
    ),
    enforceOutputLimits: parseBoolean(
      pickConfigured(env, "ENFORCE_OUTPUT_LIMITS", boolToString(tomlBool(toml, "enforce_output_limits")), "enforce_output_limits"),
      false,
    ),
    allowMaxMode: parseBoolean(
      pickConfigured(env, "ALLOW_MAX_MODE", boolToString(tomlBool(toml, "allow_max_mode")), "allow_max_mode"),
      true,
    ),
    quotaCacheReadWeight: parseWeight(
      pickConfigured(env, "QUOTA_CACHE_READ_WEIGHT", tomlWeight(toml, "quota_cache_read_weight"), "quota_cache_read_weight"),
      1,
    ),
    sseKeepaliveMs: parseOptionalInterval(
      pickConfigured(env, "SSE_KEEPALIVE_MS", intToString(tomlInt(toml, "sse_keepalive_ms")), "sse_keepalive_ms"),
      DEFAULT_SSE_KEEPALIVE_MS,
      { min: 1_000, max: 600_000 },
    ),
    maxLiveSessions: parseBoundedInt(
      pickConfigured(env, "MAX_LIVE_SESSIONS", intToString(tomlInt(toml, "max_live_sessions")), "max_live_sessions"),
      DEFAULT_MAX_LIVE_SESSIONS,
      { min: 1, max: 100_000 },
    ),
    conversationTtlDays: parseBoundedInt(
      pickConfigured(
        env,
        "CONVERSATION_TTL_DAYS",
        intToString(tomlInt(toml, "conversation_ttl_days")),
        "conversation_ttl_days",
      ),
      DEFAULT_CONVERSATION_TTL_DAYS,
      { min: 1, max: 3650 },
    ),
    cursorKeyStrategy: parseKeyStrategy(
      pickConfigured(env, "CURSOR_KEY_STRATEGY", tomlString(toml, "cursor_key_strategy"), "cursor_key_strategy"),
    ),
    cursorKeyCooldownMs: parseBoundedInt(
      pickConfigured(
        env,
        "CURSOR_KEY_COOLDOWN_MS",
        intToString(tomlInt(toml, "cursor_key_cooldown_ms")),
        "cursor_key_cooldown_ms",
      ),
      DEFAULT_CURSOR_KEY_COOLDOWN_MS,
      { min: 1_000, max: 86_400_000 },
    ),
    parkTimeoutMs: parseBoundedInt(
      pickConfigured(
        env,
        "PARK_TIMEOUT_MS",
        intToString(tomlInt(toml, "park_timeout_ms")),
        "park_timeout_ms",
      ),
      DEFAULT_PARK_TIMEOUT_MS,
      { min: 5_000, max: 3_600_000 },
    ),
    authFailureLimit: parseAuthFailureLimit(
      pickConfigured(
        env,
        "AUTH_FAILURE_LIMIT",
        intToString(tomlInt(toml, "auth_failure_limit")),
        "auth_failure_limit",
      ),
    ),
    trustedProxies: parseTrustedProxies(
      pickConfigured(env, "TRUSTED_PROXIES", tomlString(toml, "trusted_proxies"), "trusted_proxies"),
    ),
  };
}

/** GATEWAY_HOST silently beating a different gateway.toml `host` is easy to miss; say so at startup. */
function warnIfHostOverridden(
  env: NodeJS.ProcessEnv,
  tomlHost: string | undefined,
  configFile: string,
  warn: ConfigWarning,
): void {
  const fromEnv = optionalTrimmed(env.GATEWAY_HOST);
  const fromToml = optionalTrimmed(tomlHost);
  if (fromEnv === undefined || fromToml === undefined || fromEnv === fromToml) return;
  warn("GATEWAY_HOST overrides host in gateway.toml", {
    env_host: fromEnv,
    toml_host: fromToml,
    config_file: configFile,
  });
}

function ensureConfigFile(configFile: string, production: boolean): void {
  if (!production || fs.existsSync(configFile)) return;
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, EMPTY_CONFIG_TEMPLATE, "utf8");
  try {
    fs.chmodSync(configFile, 0o600);
  } catch {
    // 部分文件系统/挂载不支持 chmod
  }
}

function parseCountTokensMode(configured: { value: string | undefined; source: string }): "estimate" | "off" {
  const value = optionalTrimmed(configured.value)?.toLowerCase();
  if (value === undefined || value === "off") return "off";
  if (value === "estimate") return "estimate";
  throw new Error(`${configured.source} must be "estimate" or "off" (got ${JSON.stringify(configured.value)})`);
}

/**
 * `cursor_api_key` plus optional `cursor_api_keys` (comma-separated) form the
 * upstream key pool. At least one key is required; duplicates are dropped.
 */
function cursorKeys(
  env: NodeJS.ProcessEnv,
  toml: TomlTable,
  configFile: string,
): { cursorApiKey: string; cursorApiKeys: string[] } {
  const primary = pickString(env.CURSOR_API_KEY, tomlString(toml, "cursor_api_key"));
  const extra = pickString(env.CURSOR_API_KEYS, tomlString(toml, "cursor_api_keys"));
  const keys: string[] = [];
  for (const candidate of [primary, ...(extra ?? "").split(",")]) {
    const key = optionalTrimmed(candidate);
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  const first = keys[0];
  if (first === undefined) {
    throw new Error(
      `Missing cursor_api_key. Set environment variable CURSOR_API_KEY (or CURSOR_API_KEYS) or add it to ${configFile}`,
    );
  }
  return { cursorApiKey: first, cursorApiKeys: keys };
}

function parseKeyStrategy(configured: { value: string | undefined; source: string }): "round_robin" | "least_active" {
  const value = optionalTrimmed(configured.value)?.toLowerCase().replace("-", "_");
  if (value === undefined || value === "round_robin") return "round_robin";
  if (value === "least_active") return "least_active";
  throw new Error(
    `${configured.source} must be "round_robin" or "least_active" (got ${JSON.stringify(configured.value)})`,
  );
}

function requireSecret(
  env: NodeJS.ProcessEnv,
  envName: string,
  tomlValue: string | undefined,
  configFile: string,
  tomlKey: string,
): string {
  const value = pickString(env[envName], tomlValue);
  if (!value) {
    throw new Error(
      `Missing ${tomlKey}. Set environment variable ${envName} or add it to ${configFile}`,
    );
  }
  return value;
}

function pickString(
  envValue: string | undefined,
  tomlValue: string | undefined,
): string | undefined {
  return optionalTrimmed(envValue) ?? optionalTrimmed(tomlValue);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function pickConfigured(
  env: NodeJS.ProcessEnv,
  envName: string,
  tomlValue: string | undefined,
  tomlKey: string,
): { value: string | undefined; source: string } {
  const fromEnv = optionalTrimmed(env[envName]);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: `environment variable ${envName}` };
  }
  const fromToml = optionalTrimmed(tomlValue);
  if (fromToml !== undefined) {
    return { value: fromToml, source: `gateway.toml key ${tomlKey}` };
  }
  return { value: undefined, source: "default" };
}

function parsePositiveInt(
  configured: { value: string | undefined; source: string },
  fallback: number,
): number {
  const trimmed = optionalTrimmed(configured.value);
  if (trimmed === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `${configured.source} must be a complete positive integer (got ${JSON.stringify(trimmed)})`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${configured.source} must be a complete positive integer (got ${JSON.stringify(trimmed)})`,
    );
  }
  return parsed;
}

/** Like parseBoundedInt but allows 0, which switches the limit off. */
function parseAuthFailureLimit(configured: { value: string | undefined; source: string }): number {
  if (configured.value !== undefined && configured.value.trim() === "0") return 0;
  return parseBoundedInt(configured, 20, { min: 1, max: 1_000 });
}

/** Comma-separated IPs or CIDRs; validated when the throttle is configured. */
function parseTrustedProxies(configured: { value: string | undefined; source: string }): string[] {
  if (configured.value === undefined) return [];
  return configured.value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function parseBoundedInt(
  configured: { value: string | undefined; source: string },
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const parsed = parsePositiveInt(configured, fallback);
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${configured.source} must be between ${bounds.min} and ${bounds.max} (got ${parsed})`,
    );
  }
  return parsed;
}


function parseOptionalInterval(
  configured: { value: string | undefined; source: string }, fallback: number, bounds: { min: number; max: number },
): number {
  if (optionalTrimmed(configured.value) === "0") return 0;
  return parseBoundedInt(configured, fallback, bounds);
}

/** A decimal weight in [0, 1]. */
function parseWeight(configured: { value: string | undefined; source: string }, fallback: number): number {
  const trimmed = optionalTrimmed(configured.value);
  if (trimmed === undefined) return fallback;
  const parsed = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${configured.source} must be a number between 0 and 1 (got ${JSON.stringify(trimmed)})`);
  }
  return parsed;
}

function parseBoolean(
  configured: { value: string | undefined; source: string },
  fallback: boolean,
): boolean {
  if (configured.value === undefined) return fallback;
  const value = configured.value.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(
    `${configured.source} must be true or false (got ${JSON.stringify(configured.value)})`,
  );
}

function boolToString(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? "true" : "false";
}

function intToString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function tomlBool(table: TomlTable, key: string): boolean | undefined {
  const direct = table[key];
  if (typeof direct === "boolean") return direct;
  if (typeof direct === "string") {
    const value = direct.trim().toLowerCase();
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  for (const value of Object.values(table)) {
    if (value && typeof value === "object") {
      const nested = value[key];
      if (typeof nested === "boolean") return nested;
      if (typeof nested === "string") {
        const parsed = nested.trim().toLowerCase();
        if (parsed === "true" || parsed === "1") return true;
        if (parsed === "false" || parsed === "0") return false;
      }
    }
  }
  return undefined;
}

function tomlInt(table: TomlTable, key: string): number | undefined {
  const direct = scalarToNumber(table[key], key);
  if (direct !== undefined) return direct;
  for (const value of Object.values(table)) {
    if (value && typeof value === "object") {
      const nested = scalarToNumber(value[key] as string | number | TomlTable | undefined, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function scalarToNumber(value: string | number | boolean | TomlTable | undefined, key: string): number | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "string" && /^\d+\.\d+$/.test(value.trim())) {
    throw new Error(`${key} must be an integer (got ${value.trim()})`);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[1-9]\d*$|^0$/.test(value)) return Number(value);
  return undefined;
}

function readGitCommit(cwd: string): string | undefined {
  try {
    const gitPath = path.join(cwd, ".git");
    const stat = fs.statSync(gitPath);
    let gitRoot = gitPath;
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitPath, "utf8").trim();
      const matched = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!matched?.[1]) return undefined;
      gitRoot = path.resolve(cwd, matched[1]);
    }
    const head = fs.readFileSync(path.join(gitRoot, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref?.[1]) return undefined;
    const sha = fs.readFileSync(path.join(gitRoot, ref[1]), "utf8").trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function readVersion(cwd: string): string {
  const candidates = [
    path.join(cwd, "VERSION"),
    path.join(import.meta.dirname, "..", "VERSION"),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text !== "") return text;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return "unknown";
}

function readTomlFile(file: string): TomlTable {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Cannot read ${file}: ${errorText(error)}`);
  }
  return parseToml(text, file);
}

/** Decimal TOML value as text; a boolean is a config error, not "unset" (N4). */
function tomlWeight(table: TomlTable, key: string): string | undefined {
  const values = [table[key], ...Object.values(table).map((value) => (value && typeof value === "object" ? value[key] : undefined))];
  if (values.some((value) => typeof value === "boolean")) throw new Error(`${key} must be a number between 0 and 1`);
  return tomlString(table, key);
}

function tomlString(table: TomlTable, key: string): string | undefined {
  const direct = scalarToString(table[key]);
  if (direct !== undefined) return direct;
  for (const value of Object.values(table)) {
    if (value && typeof value === "object") {
      const nested = scalarToString(value[key] as string | number | TomlTable | undefined);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function parseCorsOrigins(value: string): string[] {
  const origins = [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
  for (const origin of origins) {
    if (origin === "*" && origins.length === 1) continue;
    try {
      const url = new URL(origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && !origin.includes("*")) continue;
    } catch {
      // Invalid origins are configuration errors, including paths and credentials.
    }
    throw new Error("CORS_ALLOW_ORIGINS / cors_allow_origins must contain exact HTTP(S) origins, '*' alone, or an empty string");
  }
  return origins;
}

function scalarToString(value: string | number | boolean | TomlTable | undefined): string | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseToml(text: string, source: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let lineNo = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = stripTomlComment(rawLine.trim());
    if (line === "") continue;
    const section = /^\[([A-Za-z0-9_]+)\]$/.exec(line);
    if (section) {
      const name = section[1];
      const existing = root[name];
      if (existing && typeof existing === "object") {
        current = existing;
      } else {
        const next: TomlTable = {};
        root[name] = next;
        current = next;
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid TOML in ${source}:${lineNo}`);
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw new Error(`Invalid TOML key in ${source}:${lineNo}`);
    }
    current[key] = parseTomlScalar(line.slice(eq + 1).trim(), source, lineNo);
  }
  return root;
}

function parseTomlScalar(raw: string, source: string, lineNo: string | number): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("\"")) {
    return parseTomlDoubleQuote(raw, source, lineNo);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (/^[1-9]\d*$|^0$/.test(raw)) {
    return Number(raw);
  }
  // Plain decimal floats (e.g. quota_cache_read_weight = 0.1) stay strings, so integer keys can
  // reject them at startup (N4) and decimal keys parse them themselves.
  if (/^(0|[1-9]\d*)\.\d+$/.test(raw)) {
    return raw;
  }
  throw new Error(`Invalid TOML value in ${source}:${lineNo}`);
}

function parseTomlDoubleQuote(raw: string, source: string, lineNo: string | number): string {
  if (!raw.endsWith("\"") || raw.length < 2) {
    throw new Error(`Unterminated TOML string in ${source}:${lineNo}`);
  }
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      throw new Error(`Invalid TOML escape in ${source}:${lineNo}`);
    }
    const escaped =
      next === "n" ? "\n" : next === "t" ? "\t" : next === "\\" || next === "\"" ? next : null;
    if (escaped === null) {
      throw new Error(`Invalid TOML escape in ${source}:${lineNo}`);
    }
    out += escaped;
    i += 1;
  }
  return out;
}

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\"") {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "#") return line.slice(0, i).trimEnd();
  }
  return line;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
