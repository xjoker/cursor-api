import type { CursorCost, ModelParam, ParsedChatMessage, ParsedChatRequest, ParsedImage, Usage } from "./contracts.js";
import { invalidRequest } from "./errors.js";

const ACCEPTED_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "frequency_penalty",
  "user",
  "seed",
  "stop",
  "logit_bias",
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
]);

const REJECTED_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "modalities",
  "audio",
  "prediction",
  "web_search_options",
] as const;

const ALLOWED_ROLES = new Set(["system", "developer", "user", "assistant"]);
const REJECTED_ROLES = new Set(["tool", "function"]);
const REJECTED_MEDIA_TYPES = new Set(["image", "audio", "input_audio", "file"]);

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

  const parsedMessages = body.messages.map((item, index) => parseMessage(item, index));
  const includeUsage = parseStreamOptions(body.stream_options);
  const images = parsedMessages.flatMap((message) => message.images);
  const messages = parsedMessages.map(({ role, content }) => ({ role, content }));

  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    includeUsage,
    ...(images.length > 0 ? { images } : {}),
    params: parseParams(body.params),
    variant: optionalNonEmptyString(body.variant, "variant"),
    reasoning_effort: optionalNonEmptyString(body.reasoning_effort, "reasoning_effort"),
    verbosity: optionalNonEmptyString(body.verbosity, "verbosity"),
    fast: parseFast(body.fast),
    optimize_for: optionalNonEmptyString(body.optimize_for, "optimize_for"),
  };
}

export function renderTranscript(messages: ParsedChatMessage[]): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
}

export function encodeNonStreamCompletion(input: {
  id: string;
  created: number;
  model: string;
  content: string;
  usage: Usage;
  cost?: CursorCost | null;
  params?: ModelParam[];
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop",
      },
    ],
    usage: encodeUsage(input.usage),
    cursor: encodeCursorExtra(input.cost, input.params),
  };
}

export function encodeStreamChunk(input: {
  id: string;
  created: number;
  model: string;
  content?: string | null;
  role?: "assistant";
  finish_reason?: "stop" | null;
  usage?: Usage | null;
  cost?: CursorCost | null;
  params?: ModelParam[];
}): Record<string, unknown> {
  const hasRole = input.role !== undefined;
  const hasContent = input.content !== undefined && input.content !== null;
  const hasFinish = input.finish_reason !== undefined && input.finish_reason !== null;
  const usage = input.usage ?? null;

  const payload: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
  };

  if (usage !== null && !hasRole && !hasContent && !hasFinish) {
    payload.choices = [];
    payload.usage = encodeUsage(usage);
    payload.cursor = encodeCursorExtra(input.cost, input.params);
    return payload;
  }

  const delta: Record<string, unknown> = {};
  if (hasRole) delta.role = input.role;
  if (hasContent) delta.content = input.content;

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

  const parsed = parseContent(item.content, index);
  return {
    role: role as ParsedChatMessage["role"],
    content: parsed.text,
    images: parsed.images,
  };
}

function parseContent(content: unknown, index: number): { text: string; images: ParsedImage[] } {
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
    if (part.type === "image_url") {
      images.push(parseImageUrlPart(part, index, partIndex));
      continue;
    }
    if (REJECTED_MEDIA_TYPES.has(part.type)) {
      throw invalidRequest(
        `messages[${String(index)}].content type '${part.type}' is not supported`,
      );
    }
    if (part.type !== "text" || typeof part.text !== "string") {
      throw invalidRequest(
        `messages[${String(index)}].content[${String(partIndex)}] must be {type:"text", text:string} or {type:"image_url", image_url:{url:string}}`,
      );
    }
    parts.push(part.text);
  }
  if (parts.length === 0 && images.length === 0) {
    throw invalidRequest(`messages[${String(index)}].content must include text or image_url`);
  }
  return { text: parts.join(""), images };
}

function parseImageUrlPart(part: Record<string, unknown>, index: number, partIndex: number): ParsedImage {
  const label = `messages[${String(index)}].content[${String(partIndex)}]`;
  const spec = part.image_url;
  const url = typeof spec === "string" ? spec : isPlainObject(spec) && typeof spec.url === "string" ? spec.url : "";
  if (url.length === 0) {
    throw invalidRequest(`${label}.image_url.url must be a non-empty string`);
  }
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
  if (dataUrl) {
    return { data: dataUrl[2] ?? "", mimeType: dataUrl[1] ?? "image/png" };
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { url };
  }
  throw invalidRequest(`${label}.image_url.url must be http(s) or a data:image/...;base64 URL`);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
