const SENSITIVE = /api[_-]?key|authorization|pepper|secret|token|password/i;

export function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(`${format("info", message, fields)}\n`);
}

export function logError(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(`${format("error", message, fields)}\n`);
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
