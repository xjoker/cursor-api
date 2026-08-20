import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./contracts.js";

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_PORT = 8787;
const DEFAULT_DATA_DIR = "data";
const CONFIG_FILE_NAME = "gateway.toml";

const EMPTY_CONFIG_TEMPLATE = `# cursor-api configuration (auto-created in container)
# Fill the three secrets below, then restart the gateway.

host = "0.0.0.0"
port = 8787

cursor_api_key = ""
admin_access_key = ""
api_key_pepper = ""
`;

interface TomlTable {
  [key: string]: string | number | TomlTable;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
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
  const defaultHost = production ? "0.0.0.0" : "127.0.0.1";

  return {
    cursorApiKey: requireSecret(
      env,
      "CURSOR_API_KEY",
      tomlString(toml, "cursor_api_key"),
      configFile,
      "cursor_api_key",
    ),
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
    gatewayHost: pickString(env.GATEWAY_HOST, tomlString(toml, "host")) ?? defaultHost,
    gatewayPort: parsePositiveInt(
      pickString(env.GATEWAY_PORT, tomlString(toml, "port")),
      DEFAULT_PORT,
      "port",
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
      "unknown",
    maxBodyBytes: MAX_BODY_BYTES,
  };
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

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = optionalTrimmed(raw);
  if (trimmed === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${name} must be a complete positive integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a complete positive integer`);
  }
  return parsed;
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

function scalarToString(value: string | number | TomlTable | undefined): string | undefined {
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

function parseTomlScalar(raw: string, source: string, lineNo: string | number): string | number {
  if (raw.startsWith("\"")) {
    return parseTomlDoubleQuote(raw, source, lineNo);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (/^[1-9]\d*$|^0$/.test(raw)) {
    return Number(raw);
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
