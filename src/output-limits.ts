import type { CursorChatResult, OutputFormat } from "./contracts.js";

/**
 * Gateway-side `max_tokens` / `stop` (`enforce_output_limits`). Cursor has no such knobs, so the
 * gateway cuts the visible text itself and the caller cancels the run.
 *
 * Tokens are estimated as {@link CHARS_PER_TOKEN} characters each (no tokenizer in the gateway);
 * thinking text is not counted. A streamed stop sequence never reaches the client: up to
 * `longest stop - 1` trailing characters are held back until they can no longer start a match.
 */
export const CHARS_PER_TOKEN = 4;

export type OutputCut = { reason: "length" } | { reason: "stop"; sequence: string };

export class OutputLimiter {
  private held = "";
  private emitted = 0;
  private cutValue: OutputCut | undefined;
  private readonly maxChars: number | undefined;
  private readonly holdBack: number;

  constructor(
    private readonly stops: readonly string[] = [],
    maxTokens?: number,
  ) {
    this.maxChars = maxTokens === undefined ? undefined : maxTokens * CHARS_PER_TOKEN;
    this.holdBack = stops.reduce((longest, stop) => Math.max(longest, stop.length - 1), 0);
  }

  get cut(): OutputCut | undefined {
    return this.cutValue;
  }

  /** Returns the text that may be shown now. Once cut, always "". */
  push(text: string): string {
    if (this.cutValue) return "";
    const buffer = this.held + text;
    this.held = "";
    let visible = buffer;
    const hit = earliestStop(buffer, this.stops);
    if (hit) {
      visible = buffer.slice(0, hit.index);
      this.cutValue = { reason: "stop", sequence: hit.sequence };
    } else if (this.holdBack > 0) {
      const keep = Math.min(this.holdBack, buffer.length);
      let split = buffer.length - keep;
      // Never split a surrogate pair.
      if (split > 0 && isHighSurrogate(buffer.charCodeAt(split - 1))) split -= 1;
      visible = buffer.slice(0, split);
      this.held = buffer.slice(split);
    }
    return this.capLength(visible);
  }

  /** End of the run: release held-back characters (still subject to the length cap). */
  flush(): string {
    if (this.cutValue) return "";
    const rest = this.held;
    this.held = "";
    return this.capLength(rest);
  }

  private capLength(text: string): string {
    if (this.maxChars === undefined) return text;
    const room = this.maxChars - this.emitted;
    if (text.length <= room) {
      this.emitted += text.length;
      return text;
    }
    let end = Math.max(0, room);
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    this.emitted += end;
    this.held = "";
    this.cutValue ??= { reason: "length" };
    if (this.cutValue.reason === "stop") this.cutValue = { reason: "length" };
    return text.slice(0, end);
  }
}

function earliestStop(text: string, stops: readonly string[]): { index: number; sequence: string } | undefined {
  let best: { index: number; sequence: string } | undefined;
  for (const sequence of stops) {
    const index = text.indexOf(sequence);
    if (index >= 0 && (!best || index < best.index)) best = { index, sequence };
  }
  return best;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Best-effort JSON mode: an instruction appended to the prompt sent upstream (never to the
 * stored messages, so conversation hashes are unchanged).
 */
export function outputFormatInstruction(format: OutputFormat | undefined): string {
  if (!format) return "";
  const base =
    "\n\n[Output format] Reply with exactly one valid JSON value and nothing else: no prose, no Markdown, no code fences.";
  if (format.type === "json_object") return `${base} The value must be a JSON object.`;
  const name = format.name ? ` named "${format.name}"` : "";
  if (format.schema === undefined) return `${base} The value must be a JSON object${name}.`;
  return `${base} The value must conform to this JSON Schema${name}: ${JSON.stringify(format.schema)}`;
}

/** Strips one surrounding ```json fence (non-stream only) and reports whether the text parses. */
export function normalizeJsonReply(text: string, stripFence: boolean): { text: string; valid: boolean } {
  let candidate = text;
  if (stripFence) {
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
    if (fenced?.[1] !== undefined) candidate = fenced[1];
  }
  try {
    JSON.parse(candidate);
    return { text: stripFence ? candidate.trim() : candidate, valid: true };
  } catch {
    return { text, valid: false };
  }
}

/** finish_reason for a successful turn: tool calls, a gateway length cut, or a normal stop. */
export function clientFinishReason(result: Pick<CursorChatResult, "finish_reason">): "tool_calls" | "length" | "stop" {
  if (result.finish_reason === "tool_calls") return "tool_calls";
  if (result.finish_reason === "length") return "length";
  return "stop";
}
