import { mkdir } from "node:fs/promises";
import {
  Agent,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
  RateLimitError,
  type AgentUsage,
  type ModelListItem,
  type ModelParameterDefinition,
  type ModelParameterValue,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type TokenUsage,
} from "@cursor/sdk";
import type { CursorChatResult, CursorCost, ModelParam, OpenAiModel, ParsedChatRequest, Usage } from "./contracts.js";
import { GatewayError, invalidRequest, rateLimitError, upstreamAuthError, upstreamError } from "./errors.js";
import { logError } from "./log.js";

const CATALOG_TTL_MS = 60_000;
const ACCOUNT_TTL_MS = 10 * 60 * 1000;

let catalogCache: { at: number; apiKey: string; models: ModelListItem[] } | undefined;
let accountCache: {
  at: number;
  apiKey: string;
  account: { api_key_name: string; created_at: string; key_kind: "user" | "team_or_service" };
} | undefined;

export async function listCursorModels(apiKey: string): Promise<OpenAiModel[]> {
  const models = await loadCatalog(apiKey);
  return models.map(toOpenAiModel);
}

export async function getCursorModel(apiKey: string, id: string): Promise<OpenAiModel | undefined> {
  const models = await loadCatalog(apiKey);
  const found = findCatalogModel(models, id);
  return found ? toOpenAiModel(found) : undefined;
}

export function peekCursorAccount(): {
  api_key_name: string;
  created_at: string;
  key_kind: "user" | "team_or_service";
} | null {
  return accountCache?.account ?? null;
}

export function warmCursorAccount(apiKey: string): void {
  void getCursorAccount(apiKey).catch((error) => {
    logError("cursor account lookup failed", {
      code: error instanceof GatewayError ? error.code : "upstream_error",
    });
  });
}

export async function getCursorAccount(apiKey: string): Promise<{
  api_key_name: string;
  created_at: string;
  key_kind: "user" | "team_or_service";
}> {
  const now = Date.now();
  if (accountCache && accountCache.apiKey === apiKey && now - accountCache.at < ACCOUNT_TTL_MS) {
    return accountCache.account;
  }
  try {
    const me = await Cursor.me({ apiKey });
    const account = {
      api_key_name: me.apiKeyName,
      created_at: me.createdAt,
      key_kind: me.userId === undefined ? ("team_or_service" as const) : ("user" as const),
    };
    accountCache = { at: now, apiKey, account };
    return account;
  } catch (error) {
    throw mapCursorError(error);
  }
}

export async function validateChatRequestModel(apiKey: string, request: ParsedChatRequest): Promise<void> {
  await resolveModelSelection(apiKey, request);
}

export async function runCursorText(options: {
  apiKey: string;
  workspaceDir: string;
  request: ParsedChatRequest;
  prompt: string;
  abortSignal: AbortSignal;
  onTextDelta?: (text: string) => void | Promise<void>;
}): Promise<CursorChatResult> {
  await mkdir(options.workspaceDir, { recursive: true });
  const model = await resolveModelSelection(options.apiKey, options.request);

  let agent: SDKAgent | undefined;
  let run: Run | undefined;
  const abortHandler = (): void => {
    if (run?.supports("cancel")) {
      void run.cancel();
    }
  };

  try {
    agent = await Agent.create({
      apiKey: options.apiKey,
      model,
      tools: [],
      local: { cwd: options.workspaceDir, settingSources: [] },
    });

    run = await agent.send(
      options.request.images && options.request.images.length > 0
        ? { text: options.prompt, images: options.request.images }
        : options.prompt,
    );
    options.abortSignal.addEventListener("abort", abortHandler, { once: true });

    if (options.abortSignal.aborted && run.supports("cancel")) {
      await run.cancel();
    }

    let streamUsage: TokenUsage | undefined;
    if (options.onTextDelta) {
      try {
        for await (const event of run.stream()) {
          if (event.type === "usage") {
            streamUsage = event.usage;
            continue;
          }
          await emitAssistantDeltas(event, options.onTextDelta);
        }
      } catch (error) {
        if (!options.abortSignal.aborted) {
          throw error;
        }
      }
    }

    if (options.abortSignal.aborted && run.supports("cancel")) {
      await run.cancel();
    }

    const result = await run.wait();
    const billed = await readBilledUsage(agent);
    const rawUsage = result.usage ?? billed?.usage ?? streamUsage;
    return {
      text: result.result ?? "",
      usage: toUsage(rawUsage),
      usageKnown: rawUsage !== undefined,
      cost: toCost(billed),
      params: model.params,
      status: result.status,
    };
  } catch (error) {
    if (options.abortSignal.aborted) {
      return { text: "", usage: toUsage(undefined), usageKnown: false, status: "cancelled" };
    }
    throw mapCursorError(error);
  } finally {
    options.abortSignal.removeEventListener("abort", abortHandler);
    await disposeAgent(agent);
  }
}

async function loadCatalog(apiKey: string): Promise<ModelListItem[]> {
  const now = Date.now();
  if (
    catalogCache &&
    catalogCache.apiKey === apiKey &&
    now - catalogCache.at < CATALOG_TTL_MS
  ) {
    return catalogCache.models;
  }
  try {
    const models = await Cursor.models.list({ apiKey });
    catalogCache = { at: now, apiKey, models };
    return models;
  } catch (error) {
    throw mapCursorError(error);
  }
}

async function resolveModelSelection(apiKey: string, request: ParsedChatRequest): Promise<ModelSelection> {
  const catalog = await loadCatalog(apiKey);
  const item = findCatalogModel(catalog, request.model);
  return {
    id: item?.id ?? request.model,
    params: resolveParams(item, request),
  };
}

function resolveParams(model: ModelListItem | undefined, request: ParsedChatRequest): ModelParameterValue[] | undefined {
  const merged = new Map<string, string>();

  if (model) {
    const defaultVariant = model.variants?.find((variant) => variant.isDefault === true);
    if (defaultVariant) {
      for (const param of defaultVariant.params) {
        merged.set(param.id, param.value);
      }
    }
  }

  if (request.variant !== undefined) {
    applyVariant(model, request.model, request.variant, merged);
  }
  if (request.params) {
    for (const param of request.params) {
      if (model) assertAllowedParam(model, param);
      merged.set(param.id, param.value);
    }
  }

  applyNamedParam(model, request.model, merged, request.reasoning_effort, {
    field: "reasoning_effort",
    ids: ["reasoning_effort", "effort", "reasoning"],
    displayName: /effort|reasoning|thinking/i,
  });
  applyNamedParam(model, request.model, merged, request.verbosity, {
    field: "verbosity",
    ids: ["verbosity"],
    displayName: /verbosity/i,
  });
  applyNamedParam(model, request.model, merged, request.fast, {
    field: "fast",
    ids: ["fast"],
    displayName: /^fast$/i,
  });
  applyNamedParam(model, request.model, merged, request.optimize_for, {
    field: "optimize_for",
    ids: ["optimize_for"],
    displayName: /optimize/i,
  });

  if (model) {
    const optimizeFor = model.parameters?.find((parameter) => parameter.id === "optimize_for");
    const first = optimizeFor?.values[0]?.value;
    if (optimizeFor && first && !merged.has("optimize_for")) {
      merged.set("optimize_for", first);
    }
  }

  if (merged.size === 0) return undefined;
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function applyVariant(
  model: ModelListItem | undefined,
  requestedId: string,
  variantName: string,
  merged: Map<string, string>,
): void {
  if (!model) {
    throw invalidRequest(`Cannot apply variant '${variantName}' because model '${requestedId}' is not in the catalog`);
  }
  const variant = model.variants?.find(
    (item) => item.displayName.toLowerCase() === variantName.toLowerCase(),
  );
  if (!variant) {
    const allowed = (model.variants ?? []).map((item) => item.displayName).join(", ") || "(none)";
    throw invalidRequest(`Unknown variant '${variantName}' for model '${model.id}'. Allowed: ${allowed}`);
  }
  for (const param of variant.params) {
    merged.set(param.id, param.value);
  }
}

function applyNamedParam(
  model: ModelListItem | undefined,
  requestedId: string,
  merged: Map<string, string>,
  raw: string | undefined,
  spec: { field: string; ids: string[]; displayName: RegExp },
): void {
  if (raw === undefined) return;
  if (!model) {
    throw invalidRequest(`Cannot map '${spec.field}' because model '${requestedId}' is not in the catalog`);
  }
  const parameter = findParameter(model, spec);
  if (!parameter) {
    throw invalidRequest(`Model '${model.id}' does not support '${spec.field}'`);
  }
  merged.set(parameter.id, matchParamValue(parameter, raw));
}

function findParameter(
  model: ModelListItem,
  spec: { ids: string[]; displayName: RegExp },
): ModelParameterDefinition | undefined {
  const ids = new Set(spec.ids.map((id) => id.toLowerCase()));
  return (
    model.parameters?.find((parameter) => ids.has(parameter.id.toLowerCase())) ??
    model.parameters?.find((parameter) => spec.displayName.test(parameter.displayName ?? ""))
  );
}

function assertAllowedParam(model: ModelListItem, param: ModelParam): void {
  const parameter = model.parameters?.find((item) => item.id === param.id);
  if (!parameter) {
    const allowed = (model.parameters ?? []).map((item) => item.id).join(", ") || "(none)";
    throw invalidRequest(`Unknown param '${param.id}' for model '${model.id}'. Allowed: ${allowed}`);
  }
  matchParamValue(parameter, param.value);
}

function matchParamValue(parameter: ModelParameterDefinition, raw: string): string {
  const exact = parameter.values.find((item) => item.value === raw);
  if (exact) return exact.value;
  const folded = raw.toLowerCase();
  const matched = parameter.values.find(
    (item) => item.value.toLowerCase() === folded || item.displayName?.toLowerCase() === folded,
  );
  if (matched) return matched.value;
  const allowed = parameter.values.map((item) => item.value).join(", ");
  throw invalidRequest(`Invalid ${parameter.id}='${raw}' for this model. Allowed: ${allowed}`);
}

function findCatalogModel(models: ModelListItem[], id: string): ModelListItem | undefined {
  const needle = id.toLowerCase();
  return models.find(
    (model) =>
      model.id.toLowerCase() === needle ||
      model.aliases?.some((alias) => alias.toLowerCase() === needle),
  );
}

function toOpenAiModel(model: ModelListItem): OpenAiModel {
  const encoded: OpenAiModel = {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    display_name: model.displayName,
  };
  if (model.description) encoded.description = model.description;
  if (model.aliases && model.aliases.length > 0) encoded.aliases = model.aliases;
  if (model.parameters && model.parameters.length > 0) {
    encoded.parameters = model.parameters.map((parameter) => ({
      id: parameter.id,
      ...(parameter.displayName ? { display_name: parameter.displayName } : {}),
      values: parameter.values.map((value) => ({
        value: value.value,
        ...(value.displayName ? { display_name: value.displayName } : {}),
      })),
    }));
  }
  if (model.variants && model.variants.length > 0) {
    encoded.variants = model.variants.map((variant) => ({
      display_name: variant.displayName,
      ...(variant.description ? { description: variant.description } : {}),
      ...(variant.isDefault === true ? { is_default: true } : {}),
      params: variant.params,
    }));
  }
  return encoded;
}

async function readBilledUsage(agent: SDKAgent): Promise<AgentUsage | undefined> {
  try {
    return await agent.getUsage();
  } catch {
    return undefined;
  }
}

function toCost(billed: AgentUsage | undefined): CursorCost | null {
  if (!billed?.cost) return null;
  return {
    raw_cost_cents: billed.cost.rawCostCents,
    charged_cents: billed.cost.chargedCents,
  };
}

async function emitAssistantDeltas(
  event: SDKMessage,
  onTextDelta: (text: string) => void | Promise<void>,
): Promise<void> {
  if (event.type !== "assistant") {
    return;
  }
  for (const block of event.message.content) {
    if (block.type === "text") {
      await onTextDelta(block.text);
    }
  }
}

function toUsage(usage: TokenUsage | undefined): Usage {
  if (!usage) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    reasoning_tokens: usage.reasoningTokens,
  };
}

async function disposeAgent(agent: SDKAgent | undefined): Promise<void> {
  if (!agent) {
    return;
  }
  if (typeof agent[Symbol.asyncDispose] === "function") {
    await agent[Symbol.asyncDispose]();
    return;
  }
  agent.close();
}

function mapCursorError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  if (error instanceof AuthenticationError) {
    return upstreamAuthError();
  }
  if (error instanceof RateLimitError) {
    return rateLimitError(error.message || "Cursor usage limit exceeded");
  }
  if (error instanceof ConfigurationError) {
    return invalidRequest(error.message);
  }
  if (error instanceof CursorSdkError && error.status === 401) {
    return upstreamAuthError();
  }
  if (error instanceof CursorSdkError && error.status === 429) {
    return rateLimitError(error.message || "Cursor usage limit exceeded");
  }
  return upstreamError();
}
