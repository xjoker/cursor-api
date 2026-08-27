import type {
  CursorCost,
  ModelParam,
  OpenAiToolCall,
  OpenAiToolFunction,
  ParsedChatMessage,
  ParsedChatRequest,
  ParsedImage,
  Usage,
} from "./contracts.js";
import { invalidRequest } from "./errors.js";

const ACCEPTED_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "user",
  "n",
  "max_tokens",
  "max_completion_tokens",
  "store",
  "metadata",
  "service_tier",
  "reasoning_effort",
  "verbosity",
  "prompt_cache_key",
  "safety_identifier",
  "response_format",
  "logprobs",
  "params",
  "variant",
  "fast",
  "optimize_for",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "conversation_id",
]);

const REJECTED_FIELDS = [
  "functions",
  "function_call",
  "modalities",
  "audio",
  "prediction",
  "web_search_options",
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "logit_bias",
] as const;

const ALLOWED_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const REJECTED_ROLES = new Set(["function"]);
const REJECTED_MEDIA_TYPES = new Set(["audio", "input_audio"]);
const SKIPPED_CONTENT_TYPES = new Set(["reasoning", "reasoning_content"]);

export function parseChatCompletionsRequest(body: unknown): ParsedChatRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest("Request body must be a JSON object");
  }

  for (const field of REJECTED_FIELDS) {
    if (field in body) {
      throw invalidRequest(`Field '${field}' is not supported`);
    }
  }

  if (body.logprobs === true) {
    throw invalidRequest("Field 'logprobs' is not supported");
  }

  if ("n" in body && body.n !== 1) {
    throw invalidRequest("Only n=1 is supported");
  }

  if ("parallel_tool_calls" in body && body.parallel_tool_calls !== true) {
    throw invalidRequest("Only parallel_tool_calls=true is supported");
  }

  if ("response_format" in body) {
    const format = body.response_format;
    if (!isPlainObject(format) || format.type !== "text") {
      throw invalidRequest("Only response_format.type 'text' is supported");
    }
  }

  for (const key of Object.keys(body)) {
    if (!ACCEPTED_FIELDS.has(key)) {
      throw invalidRequest(`Unknown field '${key}'`);
    }
  }

  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalidRequest("Field 'model' must be a non-empty string");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest("Field 'messages' must be a non-empty array");
  }

  if ("stream" in body && body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("Field 'stream' must be a boolean");
  }

  const messages = body.messages.map((item, index) => parseMessage(item, index));
  const includeUsage = parseStreamOptions(body.stream_options);
  const images = imagesOfLastUser(messages);
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice);
  const conversationId =
    optionalNonEmptyString(body.conversation_id, "conversation_id") ??
    parseMetadataConversationId(body.metadata);

  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    includeUsage,
    ...(images && images.length > 0 ? { images } : {}),
    params: parseParams(body.params),
    variant: optionalNonEmptyString(body.variant, "variant"),
    reasoning_effort: optionalNonEmptyString(body.reasoning_effort, "reasoning_effort"),
    verbosity: optionalNonEmptyString(body.verbosity, "verbosity"),
    fast: parseFast(body.fast),
    optimize_for: optionalNonEmptyString(body.optimize_for, "optimize_for"),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
}

/** 只取最后一条 user 上的图，避免把历史轮次的图摊到本次 send。 */
export function imagesOfLastUser(messages: ParsedChatMessage[]): ParsedImage[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return message.images && message.images.length > 0 ? message.images : undefined;
  }
  return undefined;
}

function parseMetadataConversationId(metadata: unknown): string | undefined {
  if (metadata === undefined) return undefined;
  if (!isPlainObject(metadata)) {
    throw invalidRequest("Field 'metadata' must be an object");
  }
  if (!("conversation_id" in metadata)) return undefined;
  return optionalNonEmptyString(metadata.conversation_id, "metadata.conversation_id");
}

export function renderTranscript(messages: ParsedChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `[tool ${message.tool_call_id ?? ""}]\n${message.content}`;
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        const calls = message.tool_calls
          .map((call) => `${call.name}(${call.arguments})`)
          .join("\n");
        const text = message.content === "" ? calls : `${message.content}\n${calls}`;
        return `[assistant]\n${text}`;
      }
      return `[${message.role}]\n${message.content}`;
    })
    .join("\n\n");
}

export function encodeNonStreamCompletion(input: {
  id: string;
  created: number;
  model: string;
  content: string;
  usage: Usage | null;
  cost?: CursorCost | null;
  params?: ModelParam[];
  tool_calls?: OpenAiToolCall[];
  finish_reason?: "stop" | "tool_calls";
  reasoning_content?: string;
}): Record<string, unknown> {
  const toolCalls = input.tool_calls;
  const finishReason =
    input.finish_reason ?? (toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop");
  const message: Record<string, unknown> = {
    role: "assistant",
    content: finishReason === "tool_calls" && input.content === "" ? null : input.content,
  };
  if (input.reasoning_content) {
    message.reasoning_content = input.reasoning_content;
  }
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(encodeToolCall);
  }
  const body: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    cursor: encodeCursorExtra(input.cost, input.params),
  };
  if (input.usage !== null) {
    body.usage = encodeUsage(input.usage);
  }
  return body;
}

export function encodeStreamChunk(input: {
  id: string;
  created: number;
  model: string;
  content?: string | null;
  reasoning_content?: string | null;
  role?: "assistant";
  finish_reason?: "stop" | "tool_calls" | null;
  usage?: Usage | null;
  cost?: CursorCost | null;
  params?: ModelParam[];
  tool_calls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
}): Record<string, unknown> {
  const hasRole = input.role !== undefined;
  const hasContent = input.content !== undefined && input.content !== null;
  const hasReasoning = input.reasoning_content !== undefined && input.reasoning_content !== null;
  const hasFinish = input.finish_reason !== undefined && input.finish_reason !== null;
  const hasTools = input.tool_calls !== undefined && input.tool_calls.length > 0;
  const usage = input.usage ?? null;

  const payload: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
  };

  if (usage !== null && !hasRole && !hasContent && !hasReasoning && !hasFinish && !hasTools) {
    payload.choices = [];
    payload.usage = encodeUsage(usage);
    payload.cursor = encodeCursorExtra(input.cost, input.params);
    return payload;
  }

  const delta: Record<string, unknown> = {};
  if (hasRole) delta.role = input.role;
  if (hasReasoning) delta.reasoning_content = input.reasoning_content;
  if (hasContent) delta.content = input.content;
  if (hasTools) {
    delta.tool_calls = input.tool_calls?.map((call) => {
      const encoded: Record<string, unknown> = { index: call.index };
      if (call.id !== undefined) {
        encoded.id = call.id;
        encoded.type = "function";
      }
      const fn: Record<string, unknown> = {};
      if (call.name !== undefined) fn.name = call.name;
      if (call.arguments !== undefined) fn.arguments = call.arguments;
      if (Object.keys(fn).length > 0) encoded.function = fn;
      return encoded;
    });
  }

  payload.choices = [
    {
      index: 0,
      delta,
      finish_reason: input.finish_reason ?? null,
    },
  ];
  if (usage !== null) {
    payload.usage = encodeUsage(usage);
  }
  return payload;
}

function parseMessage(item: unknown, index: number): ParsedChatMessage & { images: ParsedImage[] } {
  if (!isPlainObject(item)) {
    throw invalidRequest(`messages[${String(index)}] must be an object`);
  }

  const role = item.role;
  if (typeof role !== "string") {
    throw invalidRequest(`messages[${String(index)}].role is invalid`);
  }
  if (REJECTED_ROLES.has(role) || !ALLOWED_ROLES.has(role)) {
    throw invalidRequest(`messages[${String(index)}].role '${role}' is not supported`);
  }

  const toolCalls = role === "assistant" ? parseAssistantToolCalls(item.tool_calls, index) : undefined;
  const parsed = parseContent(item.content, index, {
    allowEmpty: role === "assistant" && toolCalls !== undefined,
    allowNull: role === "assistant" && toolCalls !== undefined,
  });
  const message: ParsedChatMessage & { images: ParsedImage[] } = {
    role: role as ParsedChatMessage["role"],
    content: parsed.text,
    images: parsed.images,
  };
  if (role === "tool") {
    const toolCallId = item.tool_call_id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      throw invalidRequest(`messages[${String(index)}].tool_call_id must be a non-empty string`);
    }
    message.tool_call_id = toolCallId;
  }
  if (toolCalls) {
    message.tool_calls = toolCalls;
  }
  return message;
}

function parseContent(
  content: unknown,
  index: number,
  options: { allowEmpty?: boolean; allowNull?: boolean } = {},
): { text: string; images: ParsedImage[] } {
  if (content === undefined || content === null) {
    if (options.allowNull) return { text: "", images: [] };
    throw invalidRequest(`messages[${String(index)}].content must be a string or text parts`);
  }
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    throw invalidRequest(`messages[${String(index)}].content must be a string or text parts`);
  }

  const parts: string[] = [];
  const images: ParsedImage[] = [];
  for (const [partIndex, part] of content.entries()) {
    if (!isPlainObject(part) || typeof part.type !== "string") {
      throw invalidRequest(
        `messages[${String(index)}].content[${String(partIndex)}] is invalid`,
      );
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw invalidRequest(
          `messages[${String(index)}].content[${String(partIndex)}] must be {type:"text", text:string} or an image part`,
        );
      }
      parts.push(part.text);
      continue;
    }
    if (SKIPPED_CONTENT_TYPES.has(part.type)) {
      continue;
    }
    const image = tryParseImagePart(part, index, partIndex);
    if (image) {
      images.push(image);
      continue;
    }
    if (REJECTED_MEDIA_TYPES.has(part.type)) {
      throw invalidRequest(
        `messages[${String(index)}].content type '${part.type}' is not supported`,
      );
    }
    throw invalidRequest(
      `messages[${String(index)}].content[${String(partIndex)}] must be {type:"text", text:string} or an image part (image_url, image, or image file)`,
    );
  }
  if (parts.length === 0 && images.length === 0 && !options.allowEmpty) {
    throw invalidRequest(`messages[${String(index)}].content must include text or an image`);
  }
  return { text: parts.join(""), images };
}

function tryParseImagePart(
  part: Record<string, unknown>,
  index: number,
  partIndex: number,
): ParsedImage | undefined {
  const label = `messages[${String(index)}].content[${String(partIndex)}]`;
  if (part.type === "image_url") {
    return parseImageUrlPart(part, label);
  }
  if (part.type === "image") {
    return parseGenericImagePart(part, label);
  }
  if (part.type === "file") {
    return parseFileImagePart(part, label);
  }
  return undefined;
}

function parseImageUrlPart(part: Record<string, unknown>, label: string): ParsedImage {
  const spec = part.image_url;
  const url = typeof spec === "string" ? spec : isPlainObject(spec) && typeof spec.url === "string" ? spec.url : "";
  if (url.length === 0) {
    throw invalidRequest(`${label}.image_url.url must be a non-empty string`);
  }
  return parseImageUrlString(url, `${label}.image_url.url`);
}

function parseGenericImagePart(part: Record<string, unknown>, label: string): ParsedImage {
  if ("image_url" in part) {
    return parseImageUrlPart(part, label);
  }
  const direct = firstNonEmptyString(part.url, part.image);
  if (direct) {
    return parseImageUrlString(direct, label);
  }
  const source = isPlainObject(part.source) ? part.source : undefined;
  const data = firstNonEmptyString(part.data, source?.data);
  const mimeType = firstNonEmptyString(
    part.mediaType,
    part.media_type,
    part.mimeType,
    part.mime_type,
    source?.media_type,
    source?.mime_type,
  );
  if (data) {
    if (data.startsWith("data:")) {
      return parseImageUrlString(data, label);
    }
    if (!mimeType || !mimeType.startsWith("image/")) {
      throw invalidRequest(`${label} image data requires an image media type`);
    }
    return { data, mimeType };
  }
  throw invalidRequest(`${label} must include image_url, url, or image data`);
}

function parseFileImagePart(part: Record<string, unknown>, label: string): ParsedImage {
  const spec = isPlainObject(part.file) ? part.file : part;
  const mediaType = firstNonEmptyString(
    spec.mediaType,
    spec.media_type,
    spec.mimeType,
    spec.mime_type,
    spec.mime,
    part.mediaType,
    part.media_type,
  );
  const filename = firstNonEmptyString(spec.filename, spec.name, part.filename);
  const data = firstNonEmptyString(spec.file_data, spec.data, part.data);
  const url = firstNonEmptyString(spec.url, part.url);
  if (data?.startsWith("data:")) {
    return parseImageUrlString(data, `${label}.file_data`);
  }
  if (url && isImageMedia(mediaType, filename, url)) {
    return parseImageUrlString(url, `${label}.url`);
  }
  if (data && isImageMedia(mediaType, filename, data)) {
    return { data, mimeType: mediaType && mediaType.startsWith("image/") ? mediaType : mimeFromFilename(filename) };
  }
  throw invalidRequest(`${label} file part is not an image`);
}

function parseImageUrlString(url: string, label: string): ParsedImage {
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
  if (dataUrl) {
    return { data: dataUrl[2] ?? "", mimeType: dataUrl[1] ?? "image/png" };
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { url };
  }
  throw invalidRequest(`${label} must be http(s) or a data:image/...;base64 URL`);
}

function isImageMedia(mediaType: string | undefined, filename: string | undefined, data: string): boolean {
  if (mediaType?.startsWith("image/")) return true;
  if (data.startsWith("data:image/")) return true;
  return filename !== undefined && mimeFromFilename(filename).startsWith("image/");
}

function mimeFromFilename(filename: string | undefined): string {
  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function parseStreamOptions(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (!isPlainObject(value)) {
    throw invalidRequest("Field 'stream_options' must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "include_usage") {
      throw invalidRequest(`Unknown stream_options field '${key}'`);
    }
  }
  if (!("include_usage" in value)) {
    return false;
  }
  if (typeof value.include_usage !== "boolean") {
    throw invalidRequest("stream_options.include_usage must be a boolean");
  }
  return value.include_usage;
}

function encodeUsage(usage: Usage): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
  if (usage.cache_read_tokens !== undefined) {
    encoded.prompt_tokens_details = { cached_tokens: usage.cache_read_tokens };
  }
  if (usage.cache_write_tokens !== undefined) {
    encoded.cache_write_tokens = usage.cache_write_tokens;
  }
  if (usage.reasoning_tokens !== undefined) {
    encoded.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens };
  }
  return encoded;
}

function encodeCursorExtra(cost?: CursorCost | null, params?: ModelParam[]): Record<string, unknown> {
  return {
    cost: cost ?? null,
    ...(params && params.length > 0 ? { params } : {}),
  };
}

function parseParams(value: unknown): ModelParam[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("Field 'params' must be an array of {id,value}");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item) || typeof item.id !== "string" || item.id.length === 0) {
      throw invalidRequest(`params[${String(index)}].id must be a non-empty string`);
    }
    if (typeof item.value !== "string" || item.value.length === 0) {
      throw invalidRequest(`params[${String(index)}].value must be a non-empty string`);
    }
    return { id: item.id, value: item.value };
  });
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRequest(`Field '${field}' must be a non-empty string`);
  }
  return value;
}

function parseFast(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  throw invalidRequest("Field 'fast' must be a boolean or 'true'/'false'");
}

function parseTools(value: unknown): OpenAiToolFunction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("Field 'tools' must be an array");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw invalidRequest(`tools[${String(index)}] must be an object`);
    }
    if (item.type !== undefined && item.type !== "function") {
      throw invalidRequest(`tools[${String(index)}].type must be 'function'`);
    }
    const spec = isPlainObject(item.function) ? item.function : item;
    if (typeof spec.name !== "string" || spec.name.length === 0) {
      throw invalidRequest(`tools[${String(index)}].function.name must be a non-empty string`);
    }
    const parameters =
      spec.parameters === undefined
        ? { type: "object", properties: {} }
        : spec.parameters;
    if (!isPlainObject(parameters)) {
      throw invalidRequest(`tools[${String(index)}].function.parameters must be an object`);
    }
    const tool: OpenAiToolFunction = { name: spec.name, parameters };
    if (typeof spec.description === "string" && spec.description.length > 0) {
      tool.description = spec.description;
    }
    return tool;
  });
}

function parseToolChoice(value: unknown): "auto" | "none" | { name: string } | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none") return value;
  if (value === "required") {
    throw invalidRequest("tool_choice 'required' is not supported");
  }
  if (isPlainObject(value) && value.type === "function") {
    const spec = isPlainObject(value.function) ? value.function : value;
    if (typeof spec.name !== "string" || spec.name.length === 0) {
      throw invalidRequest("Field 'tool_choice.function.name' must be a non-empty string");
    }
    return { name: spec.name };
  }
  throw invalidRequest("Field 'tool_choice' must be 'auto', 'none', 'required', or {type:'function'}");
}

function parseAssistantToolCalls(value: unknown, index: number): OpenAiToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest(`messages[${String(index)}].tool_calls must be a non-empty array`);
  }
  return value.map((item, callIndex) => {
    if (!isPlainObject(item)) {
      throw invalidRequest(`messages[${String(index)}].tool_calls[${String(callIndex)}] is invalid`);
    }
    const fn = isPlainObject(item.function) ? item.function : undefined;
    const name =
      fn && typeof fn.name === "string"
        ? fn.name
        : typeof item.name === "string"
          ? item.name
          : "";
    const args =
      fn && typeof fn.arguments === "string"
        ? fn.arguments
        : typeof item.arguments === "string"
          ? item.arguments
          : "";
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw invalidRequest(
        `messages[${String(index)}].tool_calls[${String(callIndex)}].id must be a non-empty string`,
      );
    }
    if (name.length === 0) {
      throw invalidRequest(
        `messages[${String(index)}].tool_calls[${String(callIndex)}].function.name is required`,
      );
    }
    return { id: item.id, name, arguments: args };
  });
}

function encodeToolCall(call: OpenAiToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
