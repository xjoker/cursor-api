import { randomUUID } from "node:crypto";
import type { CursorCost, ModelParam, OpenAiToolCall, ParsedChatRequest, Usage } from "./contracts.js";
import { GatewayError, invalidRequest, serverError } from "./errors.js";
import { MAX_STOP_SEQUENCE_CHARS, parseChatCompletionsRequest } from "./openai.js";

/** Messages `stop_sequences` cap (each delta is scanned for every sequence). */
const MAX_MESSAGES_STOP_SEQUENCES = 16;

/**
 * Anthropic Messages API (`POST /v1/messages`) adapter.
 *
 * Requests are translated into the Chat Completions shape and validated by
 * `parseChatCompletionsRequest`, so model knobs, tools, images and
 * conversation routing behave exactly like `/v1/chat/completions`.
 */

/**
 * Fields the gateway maps. Everything else (sampling knobs, `context_management`,
 * `safeguards`, `container`, new beta fields…) is ignored: Anthropic clients add
 * beta request fields often, and Cursor has no equivalent for them.
 */
const PASSTHROUGH_FIELDS = [
  "params",
  "variant",
  "reasoning_effort",
  "verbosity",
  "fast",
  "optimize_for",
] as const;

/** Assistant history blocks with no Cursor equivalent (thinking, server tool traffic). */
const SKIPPED_BLOCK_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
  "container_upload",
]);

export function parseAnthropicMessagesRequest(
  body: unknown,
  options: { enforceOutputLimits?: boolean } = {},
): ParsedChatRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  if ("max_tokens" in body && body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
      throw invalidRequest("Field 'max_tokens' must be a positive integer");
    }
  }
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences)) {
      throw invalidRequest("Field 'stop_sequences' must be an array");
    }
    if (body.stop_sequences.length > 0 && !options.enforceOutputLimits) {
      throw invalidRequest("Field 'stop_sequences' is not supported (enable enforce_output_limits)");
    }
    if (!body.stop_sequences.every((item) => typeof item === "string" && item !== "")) {
      throw invalidRequest("Field 'stop_sequences' must contain non-empty strings");
    }
    if (body.stop_sequences.length > MAX_MESSAGES_STOP_SEQUENCES) {
      throw invalidRequest(`Field 'stop_sequences' accepts at most ${String(MAX_MESSAGES_STOP_SEQUENCES)} entries`);
    }
    if (body.stop_sequences.some((item: string) => item.length > MAX_STOP_SEQUENCE_CHARS)) {
      throw invalidRequest(`Field 'stop_sequences' entries must be at most ${String(MAX_STOP_SEQUENCE_CHARS)} characters`);
    }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest("Field 'messages' must be a non-empty array");
  }

  const messages: Record<string, unknown>[] = [];
  const system = systemText(body.system);
  if (system !== undefined) {
    messages.push({ role: "system", content: system });
  }
  body.messages.forEach((item, index) => {
    messages.push(...convertMessage(item, index));
  });

  const chatBody: Record<string, unknown> = {
    model: body.model,
    messages: foldSystemMessages(messages),
    stream: body.stream,
    max_tokens: body.max_tokens,
    tools: convertTools(body.tools),
    tool_choice: convertToolChoice(body.tool_choice),
  };
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) chatBody[field] = body[field];
  }
  const effortHint = anthropicEffortHint(body.thinking, body.output_config);
  const conversationId = conversationIdOf(body);
  if (conversationId !== undefined) chatBody.conversation_id = conversationId;
  for (const key of Object.keys(chatBody)) {
    if (chatBody[key] === undefined) delete chatBody[key];
  }
  const parsed = parseChatCompletionsRequest(chatBody);
  parsed.includeUsage = true;
  if (effortHint !== undefined) parsed.reasoning_effort_hint = effortHint;
  if (options.enforceOutputLimits) {
    if (typeof body.max_tokens === "number") parsed.max_output_tokens = body.max_tokens;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
      parsed.stop = body.stop_sequences as string[];
    }
  }
  return parsed;
}

/**
 * `output_config.effort` (low / medium / high / max) wins; otherwise
 * `thinking.budget_tokens` picks a level and `thinking.type: "disabled"`
 * asks for the lowest. `adaptive` leaves the model default. Applied as a
 * hint, so models without an effort parameter are unaffected.
 */
export function anthropicEffortHint(thinking: unknown, outputConfig: unknown): string | undefined {
  if (isPlainObject(outputConfig) && typeof outputConfig.effort === "string" && outputConfig.effort !== "") {
    return outputConfig.effort;
  }
  if (!isPlainObject(thinking)) return undefined;
  if (thinking.type === "disabled") return "minimal";
  if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
    if (thinking.budget_tokens < 4_096) return "low";
    if (thinking.budget_tokens < 16_384) return "medium";
    return "high";
  }
  return undefined;
}

/**
 * Claude Code sends `system` messages right after a user turn (trailing on
 * the first request, then mid-history on later ones). A turn must end on a
 * user / tool message, and parked tool rounds are matched by hashing the
 * history, so a system message that follows a user / tool message is always
 * folded into it as marked context. That keeps the history identical across
 * rounds. Leading system messages stay system messages.
 */
function foldSystemMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    const foldable =
      message.role === "system" &&
      typeof message.content === "string" &&
      (previous?.role === "user" || previous?.role === "tool");
    if (!foldable || !previous) {
      out.push(message);
      continue;
    }
    if (message.content === "") continue;
    const note = `[system]\n${message.content as string}`;
    if (Array.isArray(previous.content)) {
      previous.content = [...(previous.content as unknown[]), { type: "text", text: note }];
    } else if (typeof previous.content === "string") {
      previous.content = previous.content === "" ? note : `${previous.content}\n\n${note}`;
    }
  }
  return out;
}

function systemText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  if (!Array.isArray(value)) {
    throw invalidRequest("Field 'system' must be a string or an array of text blocks");
  }
  const parts = value.map((block, index) => {
    if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
      throw invalidRequest(`system[${String(index)}] must be a text block`);
    }
    return block.text;
  });
  const text = parts.filter((part) => part !== "").join("\n\n");
  return text === "" ? undefined : text;
}

function convertMessage(item: unknown, index: number): Record<string, unknown>[] {
  const label = `messages[${String(index)}]`;
  if (!isPlainObject(item)) {
    throw invalidRequest(`${label} must be an object`);
  }
  if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") {
    throw invalidRequest(`${label}.role must be 'user', 'assistant', or 'system'`);
  }
  const blocks = normalizeBlocks(item.content, label);
  if (item.role === "system") {
    // Mid-conversation system messages (sent by Claude Code) carry text blocks only.
    const text = blocks.map((block, index) => {
      if (block.type !== "text") {
        throw invalidRequest(`${label}.content[${String(index)}] must be a text block in system messages`);
      }
      return textOf(block, `${label}.content[${String(index)}]`);
    });
    return [{ role: "system", content: text.join("\n\n") }];
  }
  return item.role === "assistant"
    ? [convertAssistant(blocks, label)]
    : convertUser(blocks, label);
}

function normalizeBlocks(content: unknown, label: string): Record<string, unknown>[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    throw invalidRequest(`${label}.content must be a string or an array of content blocks`);
  }
  return content.map((block, index) => {
    if (!isPlainObject(block) || typeof block.type !== "string") {
      throw invalidRequest(`${label}.content[${String(index)}] must be a typed content block`);
    }
    return block;
  });
}

function convertAssistant(blocks: Record<string, unknown>[], label: string): Record<string, unknown> {
  const text: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  blocks.forEach((block, index) => {
    const where = `${label}.content[${String(index)}]`;
    if (SKIPPED_BLOCK_TYPES.has(block.type as string)) return;
    if (block.type === "text") {
      text.push(textOf(block, where));
      return;
    }
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || block.id === "") {
        throw invalidRequest(`${where}.id must be a non-empty string`);
      }
      if (typeof block.name !== "string" || block.name === "") {
        throw invalidRequest(`${where}.name must be a non-empty string`);
      }
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
      return;
    }
    throw invalidRequest(`${where}.type '${String(block.type)}' is not supported in assistant messages`);
  });
  const message: Record<string, unknown> = { role: "assistant", content: text.join("") };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

/**
 * A user turn may carry `tool_result` blocks plus extra text (for example
 * client reminders). Results become `tool` messages; leftover text is folded
 * into the last result so the turn still reads as a tool-result round.
 */
function convertUser(blocks: Record<string, unknown>[], label: string): Record<string, unknown>[] {
  const toolMessages: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];
  const parts: Record<string, unknown>[] = [];
  blocks.forEach((block, index) => {
    const where = `${label}.content[${String(index)}]`;
    if (block.type === "tool_result") {
      if (typeof block.tool_use_id !== "string" || block.tool_use_id === "") {
        throw invalidRequest(`${where}.tool_use_id must be a non-empty string`);
      }
      const body = toolResultText(block.content, where);
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.is_error === true ? `[error]\n${body}` : body,
      });
      return;
    }
    if (block.type === "text") {
      parts.push({ type: "text", text: textOf(block, where) });
      return;
    }
    if (block.type === "image") {
      parts.push({ type: "image_url", image_url: { url: imageUrlOf(block, where) } });
      return;
    }
    throw invalidRequest(`${where}.type '${String(block.type)}' is not supported in user messages`);
  });

  if (toolMessages.length === 0) {
    return [{ role: "user", content: parts }];
  }
  const extra = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text as string)
    .filter((text) => text.trim() !== "");
  if (parts.some((part) => part.type === "image_url")) {
    throw invalidRequest(`${label}: images cannot be sent alongside tool_result blocks`);
  }
  if (extra.length > 0) {
    const last = toolMessages[toolMessages.length - 1];
    if (last) last.content = `${last.content}\n\n${extra.join("\n\n")}`;
  }
  return toolMessages;
}

function toolResultText(content: unknown, where: string): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw invalidRequest(`${where}.content must be a string or an array of text blocks`);
  }
  return content
    .map((block, index) => {
      if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (isPlainObject(block) && block.type === "image") {
        return "[image omitted]";
      }
      throw invalidRequest(`${where}.content[${String(index)}] must be a text block`);
    })
    .join("\n");
}

function textOf(block: Record<string, unknown>, where: string): string {
  if (typeof block.text !== "string") {
    throw invalidRequest(`${where}.text must be a string`);
  }
  return block.text;
}

function imageUrlOf(block: Record<string, unknown>, where: string): string {
  const source = block.source;
  if (!isPlainObject(source)) {
    throw invalidRequest(`${where}.source must be an object`);
  }
  if (source.type === "base64") {
    if (typeof source.media_type !== "string" || !source.media_type.startsWith("image/")) {
      throw invalidRequest(`${where}.source.media_type must be an image MIME type`);
    }
    if (typeof source.data !== "string" || source.data === "") {
      throw invalidRequest(`${where}.source.data must be a non-empty base64 string`);
    }
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url") {
    if (typeof source.url !== "string" || source.url === "") {
      throw invalidRequest(`${where}.source.url must be a non-empty string`);
    }
    return source.url;
  }
  throw invalidRequest(`${where}.source.type must be 'base64' or 'url'`);
}

function convertTools(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("Field 'tools' must be an array");
  }
  const tools: Record<string, unknown>[] = [];
  value.forEach((tool, index) => {
    if (!isPlainObject(tool)) {
      throw invalidRequest(`tools[${String(index)}] must be an object`);
    }
    // Server tools (web_search_20250305, bash_20250124, …) carry a versioned type and no schema.
    if (tool.type !== undefined && tool.type !== "custom" && tool.input_schema === undefined) {
      return;
    }
    if (typeof tool.name !== "string" || tool.name === "") {
      throw invalidRequest(`tools[${String(index)}].name must be a non-empty string`);
    }
    if (tool.input_schema !== undefined && !isPlainObject(tool.input_schema)) {
      throw invalidRequest(`tools[${String(index)}].input_schema must be an object`);
    }
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" && tool.description !== ""
          ? { description: tool.description }
          : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    });
  });
  return tools;
}

function convertToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw invalidRequest("Field 'tool_choice' must be an object with a 'type'");
  }
  switch (value.type) {
    case "auto":
    // Cursor cannot force a tool call; `any` degrades to `auto`.
    case "any":
      return "auto";
    case "none":
      return "none";
    case "tool":
      if (typeof value.name !== "string" || value.name === "") {
        throw invalidRequest("Field 'tool_choice.name' must be a non-empty string");
      }
      return { type: "function", function: { name: value.name } };
    default:
      throw invalidRequest("Field 'tool_choice.type' must be 'auto', 'any', 'tool', or 'none'");
  }
}

function conversationIdOf(body: Record<string, unknown>): unknown {
  if (body.conversation_id !== undefined) return body.conversation_id;
  const metadata = body.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (!isPlainObject(metadata)) {
    throw invalidRequest("Field 'metadata' must be an object");
  }
  return metadata.conversation_id;
}

export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export function anthropicStopReason(finishReason: string | undefined, stopSequence?: string): AnthropicStopReason {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return stopSequence !== undefined ? "stop_sequence" : "end_turn";
}

export function encodeAnthropicUsage(usage: Usage | null): Record<string, number> {
  return {
    // Anthropic `input_tokens` excludes cache reads / writes (reported separately below).
    input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - (usage?.cache_read_tokens ?? 0) - (usage?.cache_write_tokens ?? 0)),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_write_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_tokens ?? 0,
  };
}

function encodeCursorExtra(cost?: CursorCost | null, params?: ModelParam[]): Record<string, unknown> {
  return {
    cost: cost ?? null,
    ...(params && params.length > 0 ? { params } : {}),
  };
}

export function toolInputOf(argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return isPlainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: argumentsJson };
  }
}

export function encodeAnthropicMessage(input: {
  id: string;
  model: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: OpenAiToolCall[];
  finish_reason?: "stop" | "tool_calls" | "length";
  stop_sequence?: string;
  usage: Usage | null;
  cost?: CursorCost | null;
  params?: ModelParam[];
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.reasoning_content) {
    content.push({ type: "thinking", thinking: input.reasoning_content, signature: "" });
  }
  if (input.content !== "") {
    content.push({ type: "text", text: input.content });
  }
  for (const call of input.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: toolInputOf(call.arguments) });
  }
  const finish =
    input.finish_reason ?? (input.tool_calls && input.tool_calls.length > 0 ? "tool_calls" : "stop");
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.model,
    content,
    stop_reason: anthropicStopReason(finish, input.stop_sequence),
    stop_sequence: input.stop_sequence ?? null,
    usage: encodeAnthropicUsage(input.usage),
    cursor: encodeCursorExtra(input.cost, input.params),
  };
}

const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "invalid_request_error",
  413: "request_too_large",
  429: "rate_limit_error",
  499: "invalid_request_error",
  529: "overloaded_error",
};

export function anthropicErrorType(error: unknown): string {
  const mapped = error instanceof GatewayError ? error : serverError();
  return ERROR_TYPE_BY_STATUS[mapped.httpStatus] ?? "api_error";
}

export function toAnthropicErrorBody(error: unknown, requestId?: string): Record<string, unknown> {
  const mapped = error instanceof GatewayError ? error : serverError();
  return {
    type: "error",
    error: { type: anthropicErrorType(mapped), message: mapped.message, code: mapped.code },
    ...(requestId ? { request_id: requestId } : {}),
  };
}

type OpenBlock =
  | { kind: "thinking"; index: number }
  | { kind: "text"; index: number };

/** Emits Anthropic Messages SSE events (`message_start` … `message_stop`). */
export class AnthropicStreamWriter {
  private nextIndex = 0;
  private open: OpenBlock | undefined;
  private sentText = false;
  private sentToolIds = new Set<string>();

  constructor(
    private readonly emit: (event: string, data: Record<string, unknown>) => Promise<void>,
    private readonly meta: { id: string; model: string },
  ) {}

  async start(): Promise<void> {
    await this.emit("message_start", {
      type: "message_start",
      message: {
        id: this.meta.id,
        type: "message",
        role: "assistant",
        model: this.meta.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: encodeAnthropicUsage(null),
      },
    });
    await this.emit("ping", { type: "ping" });
  }

  async onThinking(text: string): Promise<void> {
    if (text === "") return;
    if (this.open?.kind !== "thinking") {
      await this.closeBlock();
      this.open = { kind: "thinking", index: this.allocate() };
      await this.emit("content_block_start", {
        type: "content_block_start",
        index: this.open.index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    }
    await this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.open.index,
      delta: { type: "thinking_delta", thinking: text },
    });
  }

  async onText(text: string): Promise<void> {
    if (text === "") return;
    if (this.open?.kind !== "text") {
      await this.closeBlock();
      this.open = { kind: "text", index: this.allocate() };
      await this.emit("content_block_start", {
        type: "content_block_start",
        index: this.open.index,
        content_block: { type: "text", text: "" },
      });
    }
    this.sentText = true;
    await this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.open.index,
      delta: { type: "text_delta", text },
    });
  }

  async onToolCalls(calls: OpenAiToolCall[]): Promise<void> {
    await this.closeBlock();
    for (const call of calls) {
      if (this.sentToolIds.has(call.id)) continue;
      this.sentToolIds.add(call.id);
      const index = this.allocate();
      await this.emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      });
      const input = JSON.stringify(toolInputOf(call.arguments));
      await this.emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: input },
      });
      await this.emit("content_block_stop", { type: "content_block_stop", index });
    }
  }

  async complete(result: {
    content: string;
    tool_calls?: OpenAiToolCall[];
    finish_reason?: "stop" | "tool_calls" | "length";
    stop_sequence?: string;
    usage: Usage | null;
  }): Promise<void> {
    if (!this.sentText && result.content !== "") {
      await this.onText(result.content);
    }
    if (result.tool_calls && result.tool_calls.length > 0) {
      await this.onToolCalls(result.tool_calls);
    }
    await this.closeBlock();
    await this.emit("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: anthropicStopReason(result.finish_reason, result.stop_sequence),
        stop_sequence: result.stop_sequence ?? null,
      },
      usage: encodeAnthropicUsage(result.usage),
    });
    await this.emit("message_stop", { type: "message_stop" });
  }

  async fail(error: unknown): Promise<void> {
    await this.closeBlock();
    const body = toAnthropicErrorBody(error);
    await this.emit("error", body);
  }

  private allocate(): number {
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  private async closeBlock(): Promise<void> {
    if (!this.open) return;
    const index = this.open.index;
    this.open = undefined;
    await this.emit("content_block_stop", { type: "content_block_stop", index });
  }
}

export function newAnthropicMessageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rough prompt-size estimate for `POST /v1/messages/count_tokens`. Cursor has
 * no tokenizer endpoint, so this counts ~4 ASCII characters per token and one
 * token per non-ASCII character over the system prompt, messages and tool
 * schemas. Clients use it for context meters, not billing.
 */
export function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (isPlainObject(value)) {
      if (value.type === "image" || value.type === "document") {
        parts.push("x".repeat(6_000)); // ~1.5k tokens per attachment
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "cache_control" || key === "signature" || key === "type" || key === "role") continue;
        if (key === "input_schema" || key === "input") {
          parts.push(JSON.stringify(item ?? null));
        } else {
          collect(item);
        }
      }
    }
  };
  collect(body.system);
  collect(body.messages);
  collect(body.tools);
  let ascii = 0;
  let other = 0;
  for (const char of parts.join("")) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + other);
}
