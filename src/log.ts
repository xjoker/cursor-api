const SENSITIVE = /api[_-]?key|authorization|pepper|secret|token|password/i;

export function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(`${format("info", message, fields)}\n`);
}

export function logError(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(`${format("error", message, fields)}\n`);
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

function format(level: string, message: string, fields?: Record<string, unknown>): string {
  const safe: Record<string, unknown> = { level, message, ts: new Date().toISOString() };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (SENSITIVE.test(key)) {
        safe[key] = "[redacted]";
        continue;
      }
      if (typeof value === "string" && SENSITIVE.test(value)) {
        safe[key] = "[redacted]";
        continue;
      }
      safe[key] = value;
    }
  }
  return JSON.stringify(safe);
}
