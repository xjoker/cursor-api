/**
 * Field names whose values are credentials. Matched as a substring of the normalized name, so
 * camelCase, kebab, plural and prefixed forms are covered (`accessToken`, `refresh_tokens`,
 * `WorkosCursorSessionToken`, `token_hash`, `client_secret_name`). The only carve-out is the exact
 * COUNT_KEYS list below, and only for numeric values.
 */
const SENSITIVE_KEY =
  /api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|pepper|secret|token|password|passwd|passphrase|credential|bearer|jwt|(^|_)key$/i;

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
const IDENTIFIER_KEYS = new Set([
  "api_key_id",
  "api_key_ids",
  "key_id",
  "key_prefix",
  "api_key_prefix",
  "api_key_name",
  // OpenAI request fields that end in `_key` but are not credentials.
  "prompt_cache_key",
  "cache_key",
  "idempotency_key",
  // Pagination cursors.
  "page_token",
  "next_page_token",
]);

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
/** Where a VALUE ends: whitespace, a quote, a backslash, a list/query separator or the end. */
const VALUE_END = String.raw`(?=$|[\s"',;&\\])`;
/**
 * A value: anything up to whitespace, a quote, a backslash or a list/query separator. A bare
 * `null`/`true`/`false` or an already-masked `[redacted]` is skipped only when it is the whole
 * value, so `token=true-S`, `password=null.S` and `token=[redacted].S` are still masked.
 */
const VALUE = String.raw`(?!\[redacted\]${VALUE_END})(?!(?:null|true|false)${VALUE_END})(?!\d+\s+tokens\b)[^\s"',;&\\]+`;
/** Whitespace between a scheme and its value, including JSON-escaped `\n`, `\r`, `\t`. */
const SCHEME_SPACE = String.raw`(?:[ \t\r\n]|\\[nrt])+`;

type Rule = { pattern: RegExp; replace: (match: string, ...args: string[]) => string };

/**
 * Credential-looking substrings inside free text, masked in place so the rest stays readable.
 * Each rule has its own replacer and only reads its own capture groups, so a pattern without a
 * group can never pick up String.replace's offset/input arguments. Every pattern starts at a
 * literal or a left-bounded run and uses bounded or run-consuming quantifiers, so the total work
 * stays linear in the input (see tests/log-count-exemption.test.mjs and request-log-redaction).
 */
const SECRET_RULES: Rule[] = [
  // `Authorization: Token abc`, `HTTP_AUTHORIZATION: Bearer\nabc`, `proxy-authorization=Basic abc`,
  // `X-Management-Key: v`: mask the scheme and value. The left boundary allows `_` so prefixed
  // names (`HTTP_AUTHORIZATION`, `x_authorization`) are covered.
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9])((?:proxy[_-])?authorization|x[_-]management[_-]key)${SEP}(?!\[redacted\]${VALUE_END})(?:[A-Za-z]+${SCHEME_SPACE})?[^\s"',;&\\]+`,
      "gi",
    ),
    replace: (_match, name, sep) => `${name}${sep}${REDACTED}`,
  },
  // `Cookie: a=b; session=S` / `Set-Cookie: ...`: the whole header value up to the line end.
  {
    pattern: /(?<![A-Za-z0-9])((?:set-)?cookie)([ \t]*:[ \t]*)(?!\[redacted\](?:$|[\r\n"\\]))[^\r\n"\\]+/gi,
    replace: (_match, name, sep) => `${name}${sep}${REDACTED}`,
  },
  // Cursor session token `user_xxx::<jwt>` (also URL-encoded `%3A%3A`): mask the whole thing.
  {
    pattern: /\buser_[A-Za-z0-9]+(?:::|%3A%3A)[A-Za-z0-9._~+/=-]+/gi,
    replace: () => REDACTED,
  },
  // `Bearer <value>`: any 8+ chars, or a shorter value with a digit, symbol or inner capital
  // (`Bearer abc1234`); plain words ("Bearer token") stay readable. No `i` flag on purpose: the
  // inner-capital alternative is case-sensitive. JSON-escaped `\n`/`\t` count as whitespace.
  // Minimum lengths are written `X{n}X*`, not `X{n,}`: on Node 22 these `{n,}` loops threw
  // RangeError (regex stack) on 8 MiB runs, the `X{n}X*` form handles 32 MiB (r3 review R3-4).
  // scrubSecrets also fails closed if the engine still throws.
  {
    pattern:
      /\b([Bb][Ee][Aa][Rr][Ee][Rr])((?:\s|\\[nrt])+)(?!\[redacted\])(?:[A-Za-z0-9._~+/=-]{8}[A-Za-z0-9._~+/=-]*|[A-Za-z0-9._~+/=-]*[0-9_~+/=-][A-Za-z0-9._~+/=-]*|[A-Za-z][a-z]*[A-Z][A-Za-z]*)(?![A-Za-z0-9._~+/=-])/g,
    replace: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  // `Basic <base64>`: 8+ base64 chars with a digit or symbol, 20+ of any, or `=` padding, so prose
  // like "Basic authentication" or "Basic Auth0 setup" stays readable.
  {
    pattern: /\b(Basic)((?:\s|\\[nrt])+)(?!\[redacted\])(?:[A-Za-z0-9+/]{20}[A-Za-z0-9+/]*={0,2}|(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{8}[A-Za-z0-9+/]*={0,2}|[A-Za-z0-9+/]{2}[A-Za-z0-9+/]*={1,2})(?![A-Za-z0-9+/=])/g,
    replace: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  { pattern: /\bcgk_[A-Za-z0-9_-]{6}[A-Za-z0-9_-]*/g, replace: () => REDACTED },
  { pattern: /\b(?:sk|key|crsr|cursor)[-_][A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g, replace: () => REDACTED },
  // Standalone JWTs (only from the start of a base64url run, so `eyJ-eyJ-...` stays linear),
  // GitHub tokens, AWS access key ids. Same `X{n}X*` form as above.
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{5}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30}[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*)/g, replace: () => REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  // URL userinfo `scheme://user:password@host`: keep the user, drop the password. Bounded parts.
  {
    pattern: /(\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^/\s:@]{1,256}:)(?!\[redacted\]@)[^@\s/]{1,512}@/g,
    replace: (_match, prefix) => `${prefix}${REDACTED}@`,
  },
  // `api_key=…`, `access_token=…`, `client_secret: …`, `"refresh_token":"…"`, `password=abc12`,
  // `tokens=…`. No left word boundary: `_` is a word character, so `\btoken` would miss
  // `access_token`. Pagination cursors (`page_token`, `pageToken`) are not secrets.
  {
    pattern: new RegExp(
      String.raw`(api[_-]?keys?|access[_-]?keys?|private[_-]?keys?|(?:admin|cursor|client|management)[_-]?keys?|(?<!page[_-]?)token|secrets?|passwords?|passwd|passphrase|pepper|credentials?|cookies?)${SEP}${VALUE}`,
      "gi",
    ),
    replace: (_match, name, sep) => `${name}${sep}${REDACTED}`,
  },
  // Plural `tokens=…` / `refresh_tokens: …` is a credential too, but a plain number (or `null`) after
  // a plural name is a count (`max_tokens: 4096`, `tokens=120`, `{"max_tokens":4096}`,
  // `max_tokens=-1`), so it stays readable. Only closing brackets may sit between the number and
  // the end of the value: `tokens=4096}S` or `tokens=4096-S` is masked.
  {
    pattern: new RegExp(
      String.raw`((?<!page[_-]?)tokens)${SEP}(?!(?:-?\d+(?:\.\d+)?|null)[}\])]*${VALUE_END})${VALUE}`,
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

/** Log messages (and the request_logs `model` column): in-place masking only, after the same length cap. */
export function scrubMessage(message: string): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field names. A real field name never carries a credential shape, so a name that any in-place rule
 * would touch is replaced whole, as is a name with whitespace that the string-value check would
 * mask (`password <secret>`). In-place masking alone would keep the secret in the R3-3 shape
 * (`Bearer token_abc <secret>` -> `Bearer [redacted] <secret>`). Ordinary credential names
 * (`access_token`, `password`) keep their text; their values are masked by isMaskedField.
 */
function redactKey(key: string): string {
  if (scrubSecrets(key) !== key) return REDACTED;
  return /\s/.test(key) && sanitizeString(key) === REDACTED ? REDACTED : key;
}

/** Nested objects deeper than this are replaced rather than walked (system log / stored bodies). */
const MAX_LOG_FIELD_DEPTH = 8;
const MAX_BODY_DEPTH = 64;

/**
 * Deep copy with credentials removed. Field names go through classifyKey/isMaskedField (exact
 * count names exempt only for numbers); strings go through `scrubString`; arrays and objects are
 * walked by their own enumerable properties (depth-capped, cycle-safe). Dates and binary views
 * carry no names to redact and are passed through so they serialize as before.
 */
function redactNode(
  value: unknown,
  scrubString: (text: string) => string,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= maxDepth) return "[truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactNode(item, scrubString, depth + 1, maxDepth, seen));
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Names can be client-controlled too (an unknown request field, a metadata key). Two names
      // that mask to the same text collapse.
      safe[redactKey(key)] = isMaskedField(classifyKey(key), item)
        ? REDACTED
        : redactNode(item, scrubString, depth + 1, maxDepth, seen);
    }
    return safe;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactNode(fields, sanitizeString, 0, MAX_LOG_FIELD_DEPTH, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Redaction for stored request/response bodies (request_logs). Same name rules and in-place masking
 * as the system log, but without the whole-value fallback or the 16 KiB string cap: these columns
 * exist to show prompts, so a message that merely mentions "token" keeps its text. The in-place
 * rules are linear, so long prompts and data URLs stay cheap.
 */
export function redactValue(value: unknown): unknown {
  return redactNode(value, scrubSecrets, 0, MAX_BODY_DEPTH, new WeakSet<object>());
}

/**
 * Stored request/response bodies (request_logs columns): JSON is redacted structurally with
 * `redactValue`; anything else (including JSON cut by truncation) is scrubbed in place. Not to be
 * confused with `redactLogText`, which is for upstream error text and masks the whole value.
 */
export function redactStoredText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const safe = redactValue(parsed);
      // A top-level `error_message` (response_detail) is error text, often from upstream: it gets
      // the raw-text check of redactLogText, not in-place masking only (r3 review R3-3 shape:
      // `Bearer token_abc <secret>`, `password <secret>`).
      if (isRecord(parsed) && isRecord(safe) && typeof parsed.error_message === "string") {
        safe.error_message = redactLogText(parsed.error_message);
      }
      return JSON.stringify(safe);
    } catch {
      // Not valid JSON (for example truncated); fall through to text scrubbing.
    }
  }
  return scrubSecrets(text);
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
