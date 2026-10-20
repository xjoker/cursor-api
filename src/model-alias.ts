import { invalidRequest } from "./errors.js";

export interface ModelAlias {
  pattern: string;
  target: string;
  matcher: RegExp;
}

/**
 * Parses `model_aliases`: `pattern=target` pairs separated by `,`, `;` or
 * newlines. `*` in a pattern matches any run of characters; matching is
 * case-insensitive and the first matching rule wins.
 *
 *   model_aliases = "client-fast-*=composer-2.5"
 */
export function parseModelAliases(raw: string | undefined, source = "model_aliases"): ModelAlias[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const eq = entry.indexOf("=");
      const pattern = eq > 0 ? entry.slice(0, eq).trim() : "";
      const target = eq > 0 ? entry.slice(eq + 1).trim() : "";
      if (pattern === "" || target === "" || target.includes("*")) {
        throw new Error(`${source}: invalid entry ${JSON.stringify(entry)} (expected pattern=target)`);
      }
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return { pattern, target, matcher: new RegExp(`^${escaped}$`, "i") };
    });
}

/** Returns the mapped model id, or the requested id when no rule matches. */
export function resolveModelAlias(aliases: readonly ModelAlias[], model: string): string {
  if (model === "") throw invalidRequest("Field 'model' must be a non-empty string");
  for (const alias of aliases) {
    if (alias.matcher.test(model)) return alias.target;
  }
  return model;
}
