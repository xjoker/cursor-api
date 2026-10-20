/**
 * Field names whose values are credentials. Matched as a substring of the normalized name, so
 * camelCase, kebab, plural and prefixed forms are covered (`accessToken`, `refresh_tokens`,
 * `WorkosCursorSessionToken`, `token_hash`, `client_secret_name`). The only carve-out is the exact
 * COUNT_KEYS list below, and only for numeric values.
 */
const SENSITIVE_KEY = /api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|pepper|secret|token|password|passwd|credential|bearer|jwt/i;

/**
 * Token-count field names (normalized to snake_case) that are logged and shown as numbers. Exact
 * names only: `access_tokens`, `refresh_tokens`, `device_tokens` and every other `*_tokens` name
 * stay credentials. A count key is only exempt when its value is a number or null; a string,
 * boolean or object under one of these names is masked like any other `token` field.
 */
const COUNT_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "budget_tokens",
  "token_count",
  "prompt_token_count",
]);

/** Usage breakdown objects (`prompt_tokens_details`): walked so nested count keys stay readable. */
const COUNT_DETAIL_KEYS = new Set([
  "input_tokens_details",
  "output_tokens_details",
  "prompt_tokens_details",
  "completion_tokens_details",
]);

/** Names that only identify a credential. Exact names only; no generic suffix exemption. */
const IDENTIFIER_KEYS = new Set(["api_key_id", "api_key_ids", "key_id", "key_prefix", "api_key_prefix", "api_key_name"]);

/** Field names longer than this are treated as credentials without being normalized (keeps it O(1)). */
const MAX_KEY_CHARS = 256;

/** `accessToken` -> `access_token`, `X-Cursor-Token` -> `x_cursor_token`, `APIKey` -> `api_key`. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

type KeyClass = "sensitive" | "count" | "count_detail" | "plain";

function classifyKey(key: string): KeyClass {
  if (key.length > MAX_KEY_CHARS) return "sensitive";
  const normalized = normalizeKey(key);
  if (IDENTIFIER_KEYS.has(normalized)) return "plain";
  if (COUNT_KEYS.has(normalized)) return "count";
  if (COUNT_DETAIL_KEYS.has(normalized)) return "count_detail";
  return SENSITIVE_KEY.test(normalized) ? "sensitive" : "plain";
}

const REDACTED = "[redacted]";

/** Separator after a field-style name: `=`, `:`, with optional (JSON-escaped) quotes. */
const SEP = String.raw`(\\?["']?\s*[:=]\s*\\?["']?)`;
/** A value: anything up to whitespace, a quote, a backslash or a list/query separator. */
const VALUE = String.raw`(?!\[redacted\])(?!(?:null|true|false)\b)(?!\d+\s+tokens\b)[^\s"',;&\\]+`;

type Rule = { pattern: RegExp; replace: (match: string, ...args: string[]) => string };

/**
 * Credential-looking substrings inside free text, masked in place so the rest stays readable.
 * Each rule has its own replacer and only reads its own capture groups, so a pattern without a
 * group can never pick up String.replace's offset/input arguments.
 */
const SECRET_RULES: Rule[] = [
  // `Authorization: Token abc`, `proxy-authorization=Basic abc`: mask the scheme and value.
  {
    pattern: new RegExp(String.raw`\b((?:proxy[_-])?authorization)${SEP}(?!\[redacted\])(?:[A-Za-z]+[ \t]+)?[^\s"',;&\\]+`, "gi"),
    replace: (_match, name, sep) => `${name}${sep}${REDACTED}`,
  },
  // Cursor session token `user_xxx::<jwt>` (also URL-encoded `%3A%3A`): mask the whole thing.
  {
    pattern: /\buser_[A-Za-z0-9]+(?:::|%3A%3A)[A-Za-z0-9._~+/=-]+/gi,
    replace: () => REDACTED,
  },
  // `Bearer <value>` (any 8+ chars) and `Basic <base64>` (needs base64 shape, so prose like
  // "Basic authentication" stays readable).
  // Minimum lengths are written `X{n}X*`, not `X{n,}`: on Node 22 these `{n,}` loops threw
  // RangeError (regex stack) on 8 MiB runs, the `X{n}X*` form handles 32 MiB (r3 review R3-4).
  // scrubSecrets also fails closed if the engine still throws.
  {
    pattern: /\b(Bearer)(\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8}[A-Za-z0-9._~+/=-]*/gi,
    replace: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  {
    pattern: /\b(Basic)(\s+)(?!\[redacted\])(?:[A-Za-z0-9+/]{20}[A-Za-z0-9+/]*={0,2}|(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{4}[A-Za-z0-9+/]*={0,2}|[A-Za-z0-9+/]{2}[A-Za-z0-9+/]*={1,2})(?![A-Za-z0-9+/=])/g,
    replace: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  { pattern: /\bcgk_[A-Za-z0-9_-]{6}[A-Za-z0-9_-]*/g, replace: () => REDACTED },
  { pattern: /\b(?:sk|key|crsr|cursor)[-_][A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g, replace: () => REDACTED },
  // `api_key=…`, `access_token=…`, `client_secret: …`, `"refresh_token":"…"`, `password=abc12`.
  // No left word boundary: `_` is a word character, so `\btoken` would miss `access_token`.
  {
    pattern: new RegExp(
      String.raw`(api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pepper|credential|cookie)${SEP}${VALUE}`,
      "gi",
    ),
    replace: (_match, name, sep) => `${name}${sep}${REDACTED}`,
  },
];

export function scrubSecrets(text: string): string {
  let out = text;
  try {
    for (const rule of SECRET_RULES) {
      out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
    }
  } catch {
    // Fail closed: if the regex engine gives up on some input (e.g. a RangeError), log nothing of it.
    return REDACTED;
  }
  return out;
}

/**
 * Credential words that make a string field value masked whole when they appear in the raw value
 * (the pre-#27 words plus `passwd`, `cookie` and `credential`).
 */
const VALUE_KEYWORDS = /api[_-]?key|authorization|pepper|secret|token|password|passwd|cookie|credential/i;

/**
 * Exact count phrases that mention `tokens` without carrying a credential: the COUNT_KEYS names
 * (snake or camelCase, e.g. `max_tokens`, `inputTokens`) and `<number> tokens`. Every alternative is
 * anchored with `\b` and has bounded length, so the scan is linear. A phrase is only exempt when an
 * allow-listed item follows it (a number, `null`, the end, a prose word); see countPhraseIsBenign.
 */
const COUNT_PHRASE =
  /\b(?:(?:max_?(?:output_?|completion_?)?|input_?|output_?|total_?|prompt_?|completion_?|reasoning_?|cached_?|cache_?(?:read|write|creation)_?(?:input_?)?|budget_?)tokens|prompt_?token_?count|\d{1,12}(?:,\d{3}){0,6}[ \t]{0,3}tokens)\b/gi;

/** Field values and log messages are cut to this many UTF-16 units before any regex runs. */
export const MAX_LOG_STRING_CHARS = 16_384;
const TRUNCATED_SUFFIX = "…[truncated]";

/**
 * Caps a log string before it reaches the regexes. The cut drops the trailing partial word as well,
 * so a secret straddling the limit cannot survive as a prefix too short for the patterns to match.
 */
function capLogString(text: string): string {
  if (text.length <= MAX_LOG_STRING_CHARS) return text;
  let end = MAX_LOG_STRING_CHARS;
  while (end > 0 && !isWordBreak(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end) + TRUNCATED_SUFFIX;
}

/** Characters that end a VALUE in the name=value rule: whitespace, quotes, backslash, `,;&`. */
function isWordBreak(code: number): boolean {
  return (
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ||
    code === 0x22 || code === 0x27 || code === 0x5c || code === 0x2c || code === 0x3b || code === 0x26
  );
}

/** Whitespace, quotes and backslashes skipped between the items that may follow a count phrase. */
function isPhraseFiller(char: string | undefined): boolean {
  return char === "\\" || char === '"' || char === "'" || char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** Separators and closing punctuation that may sit between a count phrase and its number. */
function isPhrasePunct(char: string | undefined): boolean {
  return (
    char === ":" || char === "=" || char === "," || char === "." || char === ";" ||
    char === ")" || char === "}" || char === "]" || char === ">" || char === "<"
  );
}

function isWordChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

/**
 * Prose words allowed right after a count phrase or its number (`max_tokens must be …`,
 * `8192 exceeds the limit`, `210000 tokens > 200000 maximum`). `is` alone is not one of them
 * (`max_tokens is <secret>`); `is too` is.
 */
const COUNT_PROSE_WORDS = new Set(["must", "should", "cannot", "exceeds", "exceeded", "exceed", "limit", "of", "maximum"]);
const MAX_PHRASE_FILLER = 8;
const MAX_PHRASE_NUMBER_CHARS = 24;
const MAX_PHRASE_ITEMS = 4;

/** End of a number (`4096`, `-1`, `1,234`, `0.5`) or `null` starting at `i`, followed by a word break; -1 if none. */
function countValueEnd(text: string, i: number): number {
  if (text.startsWith("null", i)) {
    return i + 4 >= text.length || !isWordChar(text.charCodeAt(i + 4)) ? i + 4 : -1;
  }
  let j = i;
  if (text[j] === "-") j += 1;
  const first = text.charCodeAt(j);
  if (!(first >= 0x30 && first <= 0x39)) return -1;
  const limit = Math.min(text.length, i + MAX_PHRASE_NUMBER_CHARS);
  while (j < limit) {
    const code = text.charCodeAt(j);
    if ((code >= 0x30 && code <= 0x39) || code === 0x2c || code === 0x2e) j += 1;
    else break;
  }
  if (j < text.length && isWordChar(text.charCodeAt(j))) return -1; // `9FAKEpw`, a 25+ digit run
  return j;
}

/** The ASCII word (at most 12 letters) starting at `i`, lower-cased, or "" when it is longer or not a word. */
function proseWordAt(text: string, i: number): string {
  let j = i;
  const limit = Math.min(text.length, i + 12);
  while (j < limit) {
    const code = text.charCodeAt(j) | 0x20;
    if (code >= 0x61 && code <= 0x7a) j += 1;
    else break;
  }
  if (j === i || (j < text.length && isWordChar(text.charCodeAt(j)))) return "";
  return text.slice(i, j).toLowerCase();
}

/**
 * Allow-list for what follows an exact count phrase (r3 review R3-2). The phrase excuses its
 * `tokens` only when it is followed by: the end of the value; a number or `null` (optionally after
 * `:`/`=`, quotes or closing punctuation), itself followed by one of these; or a prose word from
 * COUNT_PROSE_WORDS (or `is too`). Anything else right after the phrase or after its number
 * (`max_tokens=9abc`, `max_tokens: 1 abc`, `max_tokens -> abc`, `max_tokens(abc)`, newline + word,
 * `used 12 tokens abc`) keeps the phrase, so the value is masked whole. Bounded window per phrase,
 * no regex, so the scan stays linear.
 */
function countPhraseIsBenign(text: string, end: number): boolean {
  let i = end;
  for (let item = 0; item < MAX_PHRASE_ITEMS; item += 1) {
    const fillerLimit = Math.min(text.length, i + MAX_PHRASE_FILLER);
    while (i < fillerLimit && isPhraseFiller(text[i])) i += 1;
    if (i >= text.length) return true;
    if (isPhraseFiller(text[i])) return false; // more filler than the window
    if (isPhrasePunct(text[i])) {
      i += 1;
      continue;
    }
    const valueEnd = countValueEnd(text, i);
    if (valueEnd > i) {
      i = valueEnd;
      continue;
    }
    const word = proseWordAt(text, i);
    if (COUNT_PROSE_WORDS.has(word)) return true;
    if (word === "is") {
      let k = i + 2;
      while (k < text.length && k < i + 2 + MAX_PHRASE_FILLER && (text[k] === " " || text[k] === "\t")) k += 1;
      return k > i + 2 && proseWordAt(text, k) === "too";
    }
    return false;
  }
  return false;
}

/** The raw value with benign exact count phrases blanked out; used only to look for credential words. */
function withoutCountPhrases(text: string): string {
  return text.replace(COUNT_PHRASE, (phrase: string, offset: number, whole: string) =>
    countPhraseIsBenign(whole, offset + phrase.length) ? " " : phrase,
  );
}

/** Secret-like run: 16+ characters of `[A-Za-z0-9_+/=.-]` with both a letter and a digit. Linear. */
const MIN_SECRET_RUN = 16;
function hasSecretLikeRun(text: string): boolean {
  let length = 0;
  let letter = false;
  let digit = false;
  for (let i = 0; i <= text.length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    const isDigit = code >= 0x30 && code <= 0x39;
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isSymbol = code === 0x5f || code === 0x2b || code === 0x2f || code === 0x3d || code === 0x2e || code === 0x2d;
    if (isDigit || isLetter || isSymbol) {
      length += 1;
      letter ||= isLetter;
      digit ||= isDigit;
      if (length >= MIN_SECRET_RUN && letter && digit) return true;
    } else {
      length = 0;
      letter = false;
      digit = false;
    }
  }
  return false;
}

/**
 * String field values: mask known secret shapes in place; if the raw value (not the scrubbed text)
 * contains a credential word outside exact count phrases, mask the whole value as the old
 * sanitizer did. Checking the raw value matters: a rule can swallow the keyword together with the
 * secret shape next to it (`Bearer token_abc S`) and leave the real secret behind.
 */
function sanitizeString(value: string): string {
  // A cut value is checked on the full original as well: a credential word past the cut must still
  // mask the whole value (the secret may sit in the part that is kept). VALUE_KEYWORDS is a plain
  // alternation of literals, so this stays linear. No count-phrase excuse applies to a cut value.
  if (value.length > MAX_LOG_STRING_CHARS && VALUE_KEYWORDS.test(value)) return REDACTED;
  const capped = capLogString(value);
  if (VALUE_KEYWORDS.test(capped)) {
    const blanked = withoutCountPhrases(capped);
    // A count phrase only excuses the keyword when nothing else in the value looks like a secret
    // (`max_tokens is FAKEs3cr3t…` stays masked; `max_tokens must be a positive integer` does not).
    if (VALUE_KEYWORDS.test(blanked) || hasSecretLikeRun(blanked)) return REDACTED;
  }
  return scrubSecrets(capped);
}

/**
 * Free text from outside (upstream error messages) that will be logged or echoed: the same
 * treatment as a string field value. Capped first, then the whole-value check runs on the raw text,
 * then in-place scrubbing. Callers must use this instead of `scrubSecrets` when the result is later
 * logged as a field: scrubbing first lets a rule swallow the keyword (`Bearer token_abc <secret>`)
 * and the later whole-value check then sees no credential word (r3 review R3-3).
 */
export function redactLogText(text: string): string {
  return sanitizeString(text);
}

/** Log messages: in-place masking only (no whole-value fallback), after the same length cap. */
function scrubMessage(message: string): string {
  return scrubSecrets(capLogString(message));
}

export type SystemLogEntry = {
  level: "info" | "error";
  message: string;
  fields: Record<string, unknown> | null;
};

type SystemLogWriter = (entry: SystemLogEntry) => void;

let writer: SystemLogWriter | undefined;
let writing = false;

export function setSystemLogWriter(next: SystemLogWriter | undefined): void {
  writer = next;
}

export function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(`${format("info", message, fields)}\n`);
  persist("info", message, fields);
}

/** Startup warnings (stderr only; emitted before the SQLite system-log writer exists). */
export function logWarn(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(`${format("warn", message, fields)}\n`);
}

export function logError(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(`${format("error", message, fields)}\n`);
  persist("error", message, fields);
}

function persist(level: "info" | "error", message: string, fields?: Record<string, unknown>): void {
  if (!writer || writing) return;
  writing = true;
  try {
    writer({
      level,
      message: scrubMessage(message),
      fields: fields === undefined ? null : sanitizeFields(fields),
    });
  } catch {
    // SQLite persist must not recurse through logError or break the request.
  } finally {
    writing = false;
  }
}

/** Byte-safe UTF-8 truncation in O(n). Avoid character-by-character rescans. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  const suffix = "\n…[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) {
    return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let cut = maxBytes - suffixBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buf.subarray(0, cut).toString("utf8") + suffix;
}

/**
 * Credential names mask any non-empty value, numbers and booleans included (PINs, OTPs). Count
 * names are exempt only for numbers; usage-detail names only for plain objects, which are walked.
 */
function isMaskedField(kind: KeyClass, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  switch (kind) {
    case "plain":
      return false;
    case "count":
      return typeof value !== "number";
    case "count_detail":
      return typeof value !== "object" || Array.isArray(value);
    default:
      return true;
  }
}

export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = isMaskedField(classifyKey(key), value) ? REDACTED : sanitizeValue(value);
  }
  return safe;
}

function format(level: string, message: string, fields?: Record<string, unknown>): string {
  try {
    const safe: Record<string, unknown> = { level, message: scrubMessage(message), ts: new Date().toISOString() };
    if (fields) Object.assign(safe, sanitizeFields(fields));
    return JSON.stringify(safe);
  } catch {
    // Logging must never throw into the caller; drop the content rather than risk leaking it.
    return JSON.stringify({ level, message: REDACTED, ts: new Date().toISOString(), log_format_error: true });
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeFields(value as Record<string, unknown>);
  return value;
}
