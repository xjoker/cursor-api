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
  type SDKAgent,
  type SDKCustomTool,
  type TokenUsage,
} from "@cursor/sdk";
import type { ModelParam, OpenAiModel, ParsedChatRequest, Usage } from "./contracts.js";
import {
  GatewayError,
  invalidRequest,
  modelNotFound,
  rateLimitError,
  upstreamAuthError,
  upstreamError,
} from "./errors.js";
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
  await resolveChatModel(apiKey, request);
}

export async function resolveChatModel(apiKey: string, request: ParsedChatRequest): Promise<ModelSelection> {
  return resolveModelSelection(apiKey, request);
}

/**
 * OpenAI `tools` map to SDK `customTools`, which Cursor only exposes through
 * the MCP family (`custom-user-tools`). `tools: []` disables MCP, so the model
 * never sees those callbacks. When client tools are present, allow only `mcp`
 * — shell/read/edit stay off.
 */
function localChatAgentTools(hasCustomTools: boolean): Array<"mcp"> | [] {
  return hasCustomTools ? ["mcp"] : [];
}

export async function createLocalChatAgent(options: {
  apiKey: string;
  workspaceDir: string;
  model: ModelSelection;
  customTools?: Record<string, SDKCustomTool>;
}): Promise<SDKAgent> {
  await mkdir(options.workspaceDir, { recursive: true });
  const hasCustomTools =
    options.customTools !== undefined && Object.keys(options.customTools).length > 0;
  try {
    return await Agent.create({
      apiKey: options.apiKey,
      model: options.model,
      tools: localChatAgentTools(hasCustomTools),
      local: {
        cwd: options.workspaceDir,
        settingSources: [],
        ...(hasCustomTools ? { customTools: options.customTools } : {}),
      },
    });
  } catch (error) {
    throw mapCursorError(error);
  }
}

export async function resumeLocalChatAgent(options: {
  agentId: string;
  apiKey: string;
  workspaceDir: string;
  model: ModelSelection;
  customTools?: Record<string, SDKCustomTool>;
}): Promise<SDKAgent> {
  await mkdir(options.workspaceDir, { recursive: true });
  const hasCustomTools =
    options.customTools !== undefined && Object.keys(options.customTools).length > 0;
  try {
    return await Agent.resume(options.agentId, {
      apiKey: options.apiKey,
      model: options.model,
      tools: localChatAgentTools(hasCustomTools),
      local: {
        cwd: options.workspaceDir,
        settingSources: [],
        ...(hasCustomTools ? { customTools: options.customTools } : {}),
      },
    });
  } catch (error) {
    throw mapCursorError(error);
  }
}

export async function billedUsageOf(agent: SDKAgent): Promise<AgentUsage | undefined> {
  return readBilledUsage(agent);
}

export function toChatUsage(usage: TokenUsage | undefined): Usage {
  return toUsage(usage);
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
  return resolveCatalogModelSelection(catalog, request);
}

export function resolveCatalogModelSelection(
  catalog: ModelListItem[],
  request: ParsedChatRequest,
): ModelSelection {
  const item = findCatalogModel(catalog, request.model);
  if (!item) {
    throw modelNotFound(request.model);
  }
  return {
    id: item.id,
    params: resolveChatParams(item, request),
  };
}

/** Map OpenAI `variant` / `reasoning_effort` / `fast` onto Cursor catalog params. */
export function resolveChatParams(
  model: ModelListItem | undefined,
  request: ParsedChatRequest,
): ModelParameterValue[] | undefined {
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

function foldKey(value: string): string {
  return value.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim().toLowerCase();
}

function isBooleanParam(parameter: ModelParameterDefinition): boolean {
  return parameter.values.every((item) => {
    const key = foldKey(item.value);
    return key === "true" || key === "false";
  });
}

function applyVariantParams(params: ModelParameterValue[], merged: Map<string, string>): void {
  for (const param of params) {
    merged.set(param.id, param.value);
  }
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

  const needle = foldKey(variantName);
  const named = (model.variants ?? []).filter((item) => foldKey(item.displayName) === needle);
  if (named.length === 1) {
    applyVariantParams(named[0].params, merged);
    return;
  }

  const hits: Array<{ id: string; value: string }> = [];
  for (const parameter of model.parameters ?? []) {
    const nameMatch = foldKey(parameter.id) === needle || foldKey(parameter.displayName ?? "") === needle;
    if (nameMatch && isBooleanParam(parameter)) {
      const on =
        parameter.values.find((item) => foldKey(item.value) === "true") ??
        parameter.values.find((item) => foldKey(item.displayName ?? "") === needle);
      if (on) hits.push({ id: parameter.id, value: on.value });
      continue;
    }
    const matched = parameter.values.find(
      (item) => foldKey(item.value) === needle || foldKey(item.displayName ?? "") === needle,
    );
    if (matched) hits.push({ id: parameter.id, value: matched.value });
  }

  const chosen = pickVariantParamHit(hits);
  if (chosen) {
    merged.set(chosen.id, chosen.value);
    return;
  }

  throw invalidRequest(
    `Unknown variant '${variantName}' for model '${model.id}'. Allowed: ${allowedVariantNames(model)}`,
  );
}

function pickVariantParamHit(
  hits: Array<{ id: string; value: string }>,
): { id: string; value: string } | undefined {
  if (hits.length === 0) return undefined;
  const uniqueIds = [...new Set(hits.map((hit) => hit.id))];
  if (uniqueIds.length === 1) return hits[0];
  const preferred = hits.find((hit) => /^(effort|reasoning|reasoning_effort)$/i.test(hit.id));
  if (preferred && hits.filter((hit) => hit.id === preferred.id).length === 1) {
    return preferred;
  }
  return undefined;
}

function allowedVariantNames(model: ModelListItem): string {
  const variants = model.variants ?? [];
  if (variants.length === 0) return "(none)";
  const displayNames = variants.map((item) => item.displayName);
  if (new Set(displayNames.map(foldKey)).size === displayNames.length) {
    return displayNames.join(", ");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const key = foldKey(raw);
    if (!key || seen.has(key) || key === "true" || key === "false") return;
    seen.add(key);
    names.push(raw);
  };
  for (const parameter of model.parameters ?? []) {
    if (isBooleanParam(parameter)) {
      push(parameter.id);
      continue;
    }
    for (const value of parameter.values) {
      push(value.value);
    }
  }
  return names.join(", ") || displayNames.join(", ");
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

export async function disposeAgent(agent: SDKAgent | undefined): Promise<void> {
  if (!agent) {
    return;
  }
  if (typeof agent[Symbol.asyncDispose] === "function") {
    await agent[Symbol.asyncDispose]();
    return;
  }
  agent.close();
}

export function mapCursorError(error: unknown): GatewayError {
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
