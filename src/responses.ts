import { randomUUID } from "node:crypto";
import type {
  CursorCost,
  ModelParam,
  OpenAiToolCall,
  ParsedChatRequest,
  Usage,
} from "./contracts.js";
import { invalidRequest } from "./errors.js";
import { parseChatCompletionsRequest } from "./openai.js";

const ACCEPTED_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "store",
  "metadata",
  "user",
  "n",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "max_tool_calls",
  "parallel_tool_calls",
  "previous_response_id",
  "conversation",
  "conversation_id",
  "include",
  "truncation",
  "reasoning",
  "text",
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "params",
  "variant",
  "fast",
  "optimize_for",
  "reasoning_effort",
  "verbosity",
  "response_format",
  "background",
  "context_management",
]);

const SKIPPED_ITEM_TYPES = new Set(["reasoning", "item_reference", "compaction"]);
const HOSTED_TOOL_HINT = "only type 'function' tools are supported";

export function parseResponsesRequest(body: unknown): ParsedChatRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest("Request body must be a JSON object");
  }

  for (const key of Object.keys(body)) {
    if (!ACCEPTED_FIELDS.has(key)) {
      throw invalidRequest(`Unknown field '${key}'`);
    }
  }

  if (Array.isArray(body.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      if (!isPlainObject(tool)) {
        throw invalidRequest(`tools[${String(index)}] must be an object`);
      }
      if (tool.type !== undefined && tool.type !== "function") {
        throw invalidRequest(`Tool type '${String(tool.type)}' is not supported; ${HOSTED_TOOL_HINT}`);
      }
    }
  }

  if ("text" in body && body.text !== undefined) {
    if (!isPlainObject(body.text)) {
      throw invalidRequest("Field 'text' must be an object");
    }
    if ("format" in body.text && body.text.format !== undefined) {
      const format = body.text.format;
      if (!isPlainObject(format) || format.type !== "text") {
        throw invalidRequest("Only text.format.type 'text' is supported");
      }
    }
  }

  const messages = convertInputToMessages(body.input, body.instructions);
  const conversationId = conversationIdOf(body);
  const chatBody: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: body.stream,
    stream_options: body.stream_options,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    user: body.user,
    n: body.n,
    store: body.store,
    metadata: body.metadata,
    service_tier: body.service_tier,
    prompt_cache_key: body.prompt_cache_key,
    safety_identifier: body.safety_identifier,
    params: body.params,
    variant: body.variant,
    fast: body.fast,
    optimize_for: body.optimize_for,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    reasoning_effort: body.reasoning_effort ?? reasoningEffortOf(body.reasoning),
    verbosity: body.verbosity ?? textVerbosityOf(body.text),
  };
  if (conversationId) chatBody.conversation_id = conversationId;
  dropUndefined(chatBody);
  const parsed = parseChatCompletionsRequest(chatBody);
  parsed.includeUsage = true;
  return parsed;
}

export function encodeNonStreamResponse(input: {
  id: string;
  created: number;
  model: string;
  content: string;
  usage: Usage | null;
  cost?: CursorCost | null;
  params?: ModelParam[];
  tool_calls?: OpenAiToolCall[];
  finish_reason?: "stop" | "tool_calls" | "cancelled" | "error";
  reasoning_content?: string;
}): Record<string, unknown> {
  const output = encodeOutputItems(input);
  const status =
    input.finish_reason === "cancelled"
      ? "cancelled"
      : input.finish_reason === "error"
        ? "failed"
        : "completed";
  const body: Record<string, unknown> = {
    id: input.id,
    object: "response",
    created_at: input.created,
    status,
    error: null,
    incomplete_details: status === "cancelled" ? { reason: "cancelled" } : null,
    model: input.model,
    output,
    parallel_tool_calls: true,
    tools: [],
    tool_choice: "auto",
    cursor: encodeCursorExtra(input.cost, input.params),
  };
  body.usage = encodeResponsesUsage(input.usage);
  return body;
}

export function encodeResponsesUsage(usage: Usage | null): Record<string, unknown> {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage?.cache_read_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage?.reasoning_tokens ?? 0 },
  };
}

export function encodeOutputItems(input: {
  content: string;
  tool_calls?: OpenAiToolCall[];
  reasoning_content?: string;
}): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (input.reasoning_content) {
    output.push(encodeReasoningItem(newItemId("rs"), input.reasoning_content));
  }
  const toolCalls = input.tool_calls ?? [];
  if (input.content !== "" || toolCalls.length === 0) {
    output.push(encodeMessageItem(newItemId("msg"), input.content));
  }
  for (const call of toolCalls) {
    output.push(encodeFunctionCallItem(newItemId("fc"), call));
  }
  return output;
}

export class ResponsesStreamWriter {
  private sequence = 0;
  private outputIndex = 0;
  private reasoning:
    | { itemId: string; outputIndex: number; text: string }
    | undefined;
  private message:
    | { itemId: string; outputIndex: number; text: string }
    | undefined;
  private functionCalls: Array<{ itemId: string; outputIndex: number; call: OpenAiToolCall }> =
    [];
  private closedItems: Record<string, unknown>[] = [];

  constructor(
    private readonly emit: (event: string, data: Record<string, unknown>) => Promise<void>,
    private readonly meta: { id: string; created: number; model: string },
  ) {}

  async start(): Promise<void> {
    await this.event("response.created", {
      response: {
        id: this.meta.id,
        object: "response",
        created_at: this.meta.created,
        status: "in_progress",
        model: this.meta.model,
        output: [],
      },
    });
    await this.event("response.in_progress", {
      response: {
        id: this.meta.id,
        object: "response",
        created_at: this.meta.created,
        status: "in_progress",
        model: this.meta.model,
        output: [],
      },
    });
  }

  async onThinking(text: string): Promise<void> {
    if (text === "") return;
    if (!this.reasoning) {
      const itemId = newItemId("rs");
      const outputIndex = this.outputIndex;
      this.outputIndex += 1;
      this.reasoning = { itemId, outputIndex, text: "" };
      await this.event("response.output_item.added", {
        output_index: outputIndex,
        item: encodeReasoningItem(itemId, ""),
      });
      await this.event("response.reasoning_summary_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
      });
    }
    this.reasoning.text += text;
    await this.event("response.reasoning_summary_text.delta", {
      item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  async onText(text: string): Promise<void> {
    if (text === "") return;
    await this.ensureMessage();
    if (!this.message) return;
    this.message.text += text;
    await this.event("response.output_text.delta", {
      item_id: this.message.itemId,
      output_index: this.message.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  async onToolCalls(calls: OpenAiToolCall[]): Promise<void> {
    await this.closeMessage();
    for (const call of calls) {
      const itemId = newItemId("fc");
      const outputIndex = this.outputIndex;
      this.outputIndex += 1;
      this.functionCalls.push({ itemId, outputIndex, call });
      await this.event("response.output_item.added", {
        output_index: outputIndex,
        item: {
          ...encodeFunctionCallItem(itemId, { ...call, arguments: "" }),
          status: "in_progress",
        },
      });
      if (call.arguments !== "") {
        await this.event("response.function_call_arguments.delta", {
          item_id: itemId,
          output_index: outputIndex,
          delta: call.arguments,
        });
      }
      await this.event("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        name: call.name,
        arguments: call.arguments,
      });
      const doneItem = encodeFunctionCallItem(itemId, call);
      this.closedItems.push(doneItem);
      await this.event("response.output_item.done", {
        output_index: outputIndex,
        item: doneItem,
      });
    }
  }

  async complete(result: {
    content: string;
    usage: Usage | null;
    cost?: CursorCost | null;
    params?: ModelParam[];
    tool_calls?: OpenAiToolCall[];
    reasoning_content?: string;
    finish_reason?: "stop" | "tool_calls" | "cancelled" | "error";
  }): Promise<void> {
    await this.closeReasoning();
    const openMessage = this.message;
    if (result.content !== "" && openMessage === undefined) {
      await this.ensureMessage();
      const message = this.message;
      if (message) {
        message.text = result.content;
        await this.event("response.output_text.delta", {
          item_id: message.itemId,
          output_index: message.outputIndex,
          content_index: 0,
          delta: result.content,
        });
      }
    }
    await this.closeMessage();
    const status =
      result.finish_reason === "cancelled"
        ? "cancelled"
        : result.finish_reason === "error"
          ? "failed"
          : "completed";
    const event =
      status === "completed"
        ? "response.completed"
        : status === "failed"
          ? "response.failed"
          : "response.incomplete";
    await this.event(event, {
      response: {
        id: this.meta.id,
        object: "response",
        created_at: this.meta.created,
        status,
        error: null,
        incomplete_details: status === "cancelled" ? { reason: "cancelled" } : null,
        model: this.meta.model,
        output: this.snapshotOutput(result),
        usage: encodeResponsesUsage(result.usage),
        cursor: encodeCursorExtra(result.cost, result.params),
      },
    });
  }

  async fail(error: { message: string; type: string; code: string }): Promise<void> {
    await this.event("error", {
      error: {
        message: error.message,
        type: error.type,
        code: error.code,
        param: null,
      },
    });
    await this.event("response.failed", {
      response: {
        id: this.meta.id,
        object: "response",
        created_at: this.meta.created,
        status: "failed",
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
        },
        model: this.meta.model,
        output: [],
      },
    });
  }

  private async ensureMessage(): Promise<void> {
    if (this.message) return;
    await this.closeReasoning();
    const itemId = newItemId("msg");
    const outputIndex = this.outputIndex;
    this.outputIndex += 1;
    this.message = { itemId, outputIndex, text: "" };
    await this.event("response.output_item.added", {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    await this.event("response.content_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private async closeReasoning(): Promise<void> {
    const reasoning = this.reasoning;
    if (!reasoning) return;
    this.reasoning = undefined;
    await this.event("response.reasoning_summary_part.done", {
      item_id: reasoning.itemId,
      output_index: reasoning.outputIndex,
      summary_index: 0,
    });
    const item = encodeReasoningItem(reasoning.itemId, reasoning.text);
    this.closedItems.push(item);
    await this.event("response.output_item.done", {
      output_index: reasoning.outputIndex,
      item,
    });
  }

  private async closeMessage(): Promise<void> {
    const message = this.message;
    if (!message) return;
    this.message = undefined;
    await this.event("response.output_text.done", {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      text: message.text,
    });
    await this.event("response.content_part.done", {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: message.text, annotations: [] },
    });
    const item = encodeMessageItem(message.itemId, message.text);
    this.closedItems.push(item);
    await this.event("response.output_item.done", {
      output_index: message.outputIndex,
      item,
    });
  }

  private snapshotOutput(result: {
    content: string;
    tool_calls?: OpenAiToolCall[];
    reasoning_content?: string;
  }): Record<string, unknown>[] {
    if (this.closedItems.length > 0) return this.closedItems;
    return encodeOutputItems(result);
  }

  private async event(type: string, extra: Record<string, unknown>): Promise<void> {
    const sequence_number = this.sequence;
    this.sequence += 1;
    await this.emit(type, { type, sequence_number, ...extra });
  }
}

function convertInputToMessages(input: unknown, instructions: unknown): unknown[] {
  const messages: unknown[] = [];
  if (instructions !== undefined) {
    if (typeof instructions !== "string" || instructions.length === 0) {
      throw invalidRequest("Field 'instructions' must be a non-empty string");
    }
    messages.push({ role: "system", content: instructions });
  }
  if (input === undefined) {
    throw invalidRequest("Field 'input' is required");
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    throw invalidRequest("Field 'input' must be a string or an array");
  }

  let pendingCalls: OpenAiToolCall[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    pendingCalls = [];
  };

  for (const [index, raw] of input.entries()) {
    if (!isPlainObject(raw)) {
      throw invalidRequest(`input[${String(index)}] must be an object`);
    }
    const type = itemType(raw, index);
    if (type === "function_call") {
      pendingCalls.push(parseFunctionCallItem(raw, index));
      continue;
    }
    flushCalls();
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: requiredString(raw.call_id, `input[${String(index)}].call_id`),
        content: stringifyToolOutput(raw.output, index),
      });
      continue;
    }
    if (SKIPPED_ITEM_TYPES.has(type)) continue;
    if (type === "message") {
      messages.push(convertMessageItem(raw, index));
      continue;
    }
    throw invalidRequest(`input[${String(index)}].type '${type}' is not supported`);
  }
  flushCalls();
  return synthesizeAssistantForToolOnly(messages);
}

function synthesizeAssistantForToolOnly(messages: unknown[]): unknown[] {
  const roles = messages.map((item) =>
    isPlainObject(item) && typeof item.role === "string" ? item.role : "",
  );
  const hasUserOrAssistant = roles.some((role) => role === "user" || role === "assistant");
  const toolIndexes = roles
    .map((role, index) => (role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  if (hasUserOrAssistant || toolIndexes.length === 0) return messages;
  const tools = toolIndexes.map((index) => messages[index]);
  const prefix = messages.filter((_, index) => !toolIndexes.includes(index));
  const toolCalls = tools.map((item) => {
    const id =
      isPlainObject(item) && typeof item.tool_call_id === "string" ? item.tool_call_id : "call_unknown";
    return {
      id,
      type: "function",
      function: { name: "tool", arguments: "{}" },
    };
  });
  return [
    ...prefix,
    { role: "assistant", content: null, tool_calls: toolCalls },
    ...tools,
  ];
}

function convertMessageItem(item: Record<string, unknown>, index: number): Record<string, unknown> {
  const role = requiredString(item.role, `input[${String(index)}].role`);
  const message: Record<string, unknown> = {
    role,
    content: convertContent(item.content, role, index),
  };
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    message.tool_calls = item.tool_calls;
  }
  return message;
}

function convertContent(content: unknown, role: string, index: number): unknown {
  if (content === undefined || content === null) {
    if (role === "assistant") return null;
    throw invalidRequest(`input[${String(index)}].content must be a string or parts`);
  }
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw invalidRequest(`input[${String(index)}].content must be a string or parts`);
  }
  return content.map((part, partIndex) => convertContentPart(part, index, partIndex));
}

function convertContentPart(part: unknown, index: number, partIndex: number): unknown {
  const label = `input[${String(index)}].content[${String(partIndex)}]`;
  if (!isPlainObject(part) || typeof part.type !== "string") {
    throw invalidRequest(`${label} is invalid`);
  }
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    if (typeof part.text !== "string") {
      throw invalidRequest(`${label}.text must be a string`);
    }
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image" || part.type === "image_url" || part.type === "image") {
    const url = imageUrlOf(part);
    if (!url) {
      throw invalidRequest(`${label} must include image_url`);
    }
    return { type: "image_url", image_url: { url } };
  }
  if (part.type === "input_file" || part.type === "file") {
    return { type: "file", file: isPlainObject(part.file) ? part.file : part };
  }
  if (part.type === "reasoning" || part.type === "reasoning_content") {
    return { type: "reasoning", text: typeof part.text === "string" ? part.text : "" };
  }
  return part;
}

function imageUrlOf(part: Record<string, unknown>): string {
  if (typeof part.image_url === "string" && part.image_url.length > 0) return part.image_url;
  if (isPlainObject(part.image_url) && typeof part.image_url.url === "string") {
    return part.image_url.url;
  }
  if (typeof part.url === "string" && part.url.length > 0) return part.url;
  return "";
}

function parseFunctionCallItem(item: Record<string, unknown>, index: number): OpenAiToolCall {
  return {
    id: requiredString(item.call_id, `input[${String(index)}].call_id`),
    name: requiredString(item.name, `input[${String(index)}].name`),
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  };
}

function stringifyToolOutput(output: unknown, index: number): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (isPlainObject(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (output === undefined || output === null) return "";
  throw invalidRequest(`input[${String(index)}].output must be a string or text parts`);
}

function itemType(item: Record<string, unknown>, index: number): string {
  if (typeof item.type === "string" && item.type.length > 0) return item.type;
  if (typeof item.role === "string") return "message";
  throw invalidRequest(`input[${String(index)}] must have type or role`);
}

function conversationIdOf(body: Record<string, unknown>): string | undefined {
  const direct = optionalNonEmpty(body.conversation_id);
  if (direct) return direct;
  if (typeof body.conversation === "string" && body.conversation.length > 0) {
    return body.conversation;
  }
  if (isPlainObject(body.conversation) && typeof body.conversation.id === "string") {
    return optionalNonEmpty(body.conversation.id);
  }
  if (isPlainObject(body.metadata) && typeof body.metadata.conversation_id === "string") {
    return optionalNonEmpty(body.metadata.conversation_id);
  }
  return optionalNonEmpty(body.previous_response_id);
}

function reasoningEffortOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  return optionalNonEmpty(value.effort);
}

function textVerbosityOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  return optionalNonEmpty(value.verbosity);
}

function encodeMessageItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function encodeFunctionCallItem(id: string, call: OpenAiToolCall): Record<string, unknown> {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

function encodeReasoningItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    status: "completed",
    summary: text === "" ? [] : [{ type: "summary_text", text }],
  };
}

function encodeCursorExtra(cost?: CursorCost | null, params?: ModelParam[]): Record<string, unknown> {
  return {
    cost: cost ?? null,
    ...(params && params.length > 0 ? { params } : {}),
  };
}

function newItemId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRequest(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dropUndefined(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
