import { mkdir } from "node:fs/promises";
import {
  AgentBusyError,
  Agent,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
  NetworkError,
  RateLimitError,
  type AgentUsage,
  type ModelListItem,
  type ModelParameterDefinition,
  type ModelParameterValue,
  type ModelSelection,
  type ModelVariant,
  type SDKAgent,
  type SDKCustomTool,
  type TokenUsage,
} from "@cursor/sdk";
import type { ModelParam, OpenAiModel, ParsedChatRequest, Usage } from "./contracts.js";
import {
  GatewayError,
  invalidRequest,
  maxModeNotAllowed,
  modelNotAllowed,
  modelNotFound,
  rateLimitError,
  conversationBusyError,
  upstreamAuthError,
  upstreamError,
  upstreamTimeout,
  upstreamUnavailable,
} from "./errors.js";
import { logError, scrubSecrets } from "./log.js";
import { isCatalogModelAllowed } from "./key-policy.js";

const CATALOG_TTL_MS = 60_000;
const ACCOUNT_TTL_MS = 10 * 60 * 1000;

/** Per-key catalog cache so key rotation does not refetch the catalog on every request. */
const catalogCache = new Map<string, { at: number; models: ModelListItem[] }>();
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

/** Per-request (per client key) model policy. */
export interface ModelSelectionOptions {
  /** Overrides the gateway-wide `allow_max_mode` when not null/undefined. */
  allowMaxMode?: boolean | null;
  /** Client-key allowlist (exact ids or `*` globs); null/undefined = unrestricted. */
  allowedModels?: string[] | null;
}

let gatewayAllowMaxMode = true;

/** Gateway-wide `allow_max_mode` (default true = keep SDK behaviour). */
export function configureMaxMode(options: { allowMaxMode: boolean }): void {
  gatewayAllowMaxMode = options.allowMaxMode;
}

export async function validateChatRequestModel(
  apiKey: string,
  request: ParsedChatRequest,
  options?: ModelSelectionOptions,
): Promise<void> {
  await resolveChatModel(apiKey, request, options);
}

export async function resolveChatModel(
  apiKey: string,
  request: ParsedChatRequest,
  options?: ModelSelectionOptions,
): Promise<ModelSelection> {
  return resolveModelSelection(apiKey, request, options);
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
  const cached = catalogCache.get(apiKey);
  if (cached && now - cached.at < CATALOG_TTL_MS) {
    return cached.models;
  }
  try {
    const models = await Cursor.models.list({ apiKey });
    catalogCache.set(apiKey, { at: now, models });
    return models;
  } catch (error) {
    throw mapCursorError(error);
  }
}

async function resolveModelSelection(
  apiKey: string,
  request: ParsedChatRequest,
  options?: ModelSelectionOptions,
): Promise<ModelSelection> {
  const catalog = await loadCatalog(apiKey);
  return resolveCatalogModelSelection(catalog, request, options);
}

/**
 * Resolves the catalog model and params for a request.
 *
 * Max mode: since @cursor/sdk 1.0.38 the SDK itself sets `maxMode: true` whenever `params` is
 * non-empty and every catalog variant containing all of those params has `isMaxMode`
 * (`sdkWouldUseMaxMode`). Passing `maxMode: false` does NOT prevent that — the SDK overwrites it —
 * so the only reliable guard is choosing params that do not trigger the rule. When max mode is
 * disallowed we therefore:
 *   1. keep the client's explicit choices (`params`, `variant`, `reasoning_effort`, `fast`, …),
 *   2. replace the default-variant base with the closest non-max variant consistent with them,
 *   3. reject with 403 `max_mode_not_allowed` when no such variant exists (max-only models, or the
 *      client explicitly asked for a max-only variant). Anthropic effort hints are soft: a hint
 *      that only matches max variants is dropped instead of rejecting.
 * When the rule fires and max mode is allowed, the selection carries `maxMode: true` explicitly
 * (same as what the SDK would send) so logs and responses can report it.
 */
export function resolveCatalogModelSelection(
  catalog: ModelListItem[],
  request: ParsedChatRequest,
  options?: ModelSelectionOptions,
): ModelSelection {
  const item = findCatalogModel(catalog, request.model);
  if (!item) {
    throw modelNotFound(request.model);
  }
  if (!isCatalogModelAllowed({ allowedModels: options?.allowedModels ?? null, allowMaxMode: null }, request.model, item.id)) {
    throw modelNotAllowed(request.model);
  }
  const params = resolveChatParams(item, request);
  const autoMax = sdkWouldUseMaxMode(item, params);
  const allowMaxMode = options?.allowMaxMode ?? gatewayAllowMaxMode;
  if (allowMaxMode) {
    return autoMax ? { id: item.id, params, maxMode: true } : { id: item.id, params };
  }
  const hasMaxVariants = (item.variants ?? []).some((variant) => variant.isMaxMode === true);
  if (!hasMaxVariants || (!autoMax && matchesNonMaxVariant(item, params))) {
    return { id: item.id, params };
  }
  // Max-only combination, or a mix (e.g. max-only context + low effort) that matches no variant:
  // rebuild from the closest non-max variant instead of guessing how upstream bills it.
  // Anthropic `output_config.effort` / thinking budgets are soft hints: drop them before rejecting.
  const candidates =
    request.reasoning_effort_hint !== undefined ? [request, { ...request, reasoning_effort_hint: undefined }] : [request];
  for (const candidate of candidates) {
    const fallback = nonMaxParams(item, candidate);
    if (fallback && !sdkWouldUseMaxMode(item, fallback)) {
      return { id: item.id, params: fallback };
    }
  }
  if (!autoMax) return { id: item.id, params };
  throw maxModeNotAllowed(item.id);
}

function matchesNonMaxVariant(model: ModelListItem, params: ModelParameterValue[] | undefined): boolean {
  const variants = model.variants ?? [];
  const ids = new Set(variants.flatMap((variant) => variant.params.map((param) => param.id.trim())));
  const constraining = (params ?? []).filter((param) => ids.has(param.id.trim()));
  return variants.some((variant) => variant.isMaxMode !== true && variantContains(variant, constraining));
}

/** Exact copy of the @cursor/sdk 1.0.38 auto max-mode rule (local-model validation). */
export function sdkWouldUseMaxMode(model: ModelListItem, params: ModelParameterValue[] | undefined): boolean {
  const wanted = params ?? [];
  if (wanted.length === 0) return false;
  const matching = (model.variants ?? []).filter((variant) => variantContains(variant, wanted));
  return matching.length > 0 && matching.every((variant) => variant.isMaxMode === true);
}

function variantContains(variant: ModelVariant, params: ModelParameterValue[]): boolean {
  return params.every((param) =>
    variant.params.some((own) => own.id.trim() === param.id.trim() && own.value.trim() === param.value.trim()),
  );
}

/**
 * Params for the closest non-max variant that honours the client's explicit choices, or
 * undefined when every compatible variant is max-only.
 */
function nonMaxParams(model: ModelListItem, request: ParsedChatRequest): ModelParameterValue[] | undefined {
  const variants = model.variants ?? [];
  const withoutDefault: ModelListItem = {
    ...model,
    variants: variants.map(({ isDefault: _isDefault, ...variant }) => variant),
  };
  const explicit = resolveChatParams(withoutDefault, request) ?? [];
  const variantParamIds = new Set(variants.flatMap((variant) => variant.params.map((param) => param.id.trim())));
  const constraining = explicit.filter((param) => variantParamIds.has(param.id.trim()));
  const defaults = variants.find((variant) => variant.isDefault === true)?.params ?? [];
  let best: { variant: ModelVariant; score: number } | undefined;
  for (const variant of variants) {
    if (variant.isMaxMode === true || !variantContains(variant, constraining)) continue;
    const score = variant.params.filter((param) =>
      defaults.some((own) => own.id.trim() === param.id.trim() && own.value.trim() === param.value.trim()),
    ).length;
    if (!best || score > best.score) best = { variant, score };
  }
  if (!best) return undefined;
  const merged = new Map(best.variant.params.map((param) => [param.id, param.value]));
  for (const param of explicit) merged.set(param.id, param.value);
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
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

  applyReasoningEffort(model, request.model, merged, request.reasoning_effort);
  if (request.reasoning_effort === undefined && request.reasoning_effort_hint !== undefined && model) {
    applyEffortHint(model, merged, request.reasoning_effort_hint);
  }
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

const EFFORT_RANK = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_OFF = new Set(["none", "off", "minimal"]);

/**
 * OpenAI `reasoning_effort` (Chat Completions, Responses top level, Messages extension).
 * A value the model lists is used as is (explicit choice, so max-mode rules still apply);
 * a standard level the model lacks maps to the nearest one; a model without an effort
 * control ignores it. Only values that are neither listed nor a standard level are 400.
 */
function applyReasoningEffort(
  model: ModelListItem | undefined,
  requestedId: string,
  merged: Map<string, string>,
  raw: string | undefined,
): void {
  if (raw === undefined) return;
  if (!model) {
    throw invalidRequest(`Cannot map 'reasoning_effort' because model '${requestedId}' is not in the catalog`);
  }
  const wanted = foldKey(raw);
  const parameter = findParameter(model, { ids: ["reasoning_effort", "effort", "reasoning"], displayName: /effort|reasoning|thinking/i });
  const exact = parameter?.values.find((value) => foldKey(value.value) === wanted || foldKey(value.displayName ?? "") === wanted);
  if (parameter && exact) {
    merged.set(parameter.id, exact.value);
    return;
  }
  if (!EFFORT_RANK.includes(wanted)) {
    const allowed = parameter ? parameter.values.map((item) => item.value).join(", ") : EFFORT_RANK.join(", ");
    throw invalidRequest(`Invalid reasoning_effort='${raw}'. Allowed: ${allowed}`);
  }
  if (!parameter) return;
  if (isBooleanParam(parameter)) {
    const on = !EFFORT_OFF.has(wanted);
    const value = parameter.values.find((item) => foldKey(item.value) === String(on));
    if (value) merged.set(parameter.id, value.value);
    return;
  }
  applyEffortHint(model, merged, raw);
}

export function applyEffortHint(model: ModelListItem, merged: Map<string, string>, hint: string): void {
  const parameter = findParameter(model, { ids: ["reasoning_effort", "effort", "reasoning"], displayName: /effort|reasoning|thinking/i });
  if (!parameter || isBooleanParam(parameter)) return;
  const wanted = foldKey(hint);
  const exact = parameter.values.find((value) => foldKey(value.value) === wanted || foldKey(value.displayName ?? "") === wanted);
  if (exact) {
    merged.set(parameter.id, exact.value);
    return;
  }
  const target = EFFORT_RANK.indexOf(wanted);
  if (target < 0) return;
  let best: { value: string; distance: number; rank: number } | undefined;
  for (const value of parameter.values) {
    const rank = EFFORT_RANK.indexOf(foldKey(value.value));
    if (rank < 0) continue;
    const distance = Math.abs(rank - target);
    if (!best || distance < best.distance || (distance === best.distance && rank < best.rank)) best = { value: value.value, distance, rank };
  }
  if (best) merged.set(parameter.id, best.value);
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

export function toOpenAiModel(model: ModelListItem): OpenAiModel {
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
      ...(variant.isMaxMode === true ? { is_max_mode: true } : {}),
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

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function toUsage(usage: TokenUsage | undefined): Usage {
  if (!usage) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  // SDK `inputTokens` excludes cache reads/writes (its totalTokens = input + output + cacheRead +
  // cacheWrite). OpenAI's `prompt_tokens` includes cached tokens, so fold them in and keep
  // total = prompt + completion. Anthropic encoders subtract the cache parts again.
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const prompt = nonNegative(usage.inputTokens) + cacheRead + cacheWrite;
  const completion = nonNegative(usage.outputTokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: nonNegative(usage.reasoningTokens) } : {}),
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
  const mapped = classifyCursorError(error);
  const sdk = error instanceof CursorSdkError ? error : undefined;
  logError("cursor upstream error", {
    code: mapped.code,
    http_status: mapped.httpStatus,
    error_name: error instanceof Error ? error.name : typeof error,
    ...(sdk?.code ? { upstream_code: sdk.code } : {}),
    ...(sdk?.status !== undefined ? { upstream_status: sdk.status } : {}),
    ...(sdk?.operation ? { operation: sdk.operation } : {}),
    ...(sdk?.requestId ? { upstream_request_id: sdk.requestId } : {}),
    ...(sdk ? { retryable: sdk.isRetryable } : {}),
  });
  return mapped;
}

function classifyCursorError(error: unknown): GatewayError {
  if (error instanceof AuthenticationError) {
    return upstreamAuthError();
  }
  if (error instanceof RateLimitError) {
    return rateLimitError(error.message || "Cursor usage limit exceeded");
  }
  if (error instanceof AgentBusyError) return conversationBusyError();
  if (error instanceof ConfigurationError) {
    // 1.0.38 raises a retryable ConfigurationError when its catalog lookup (max-mode check) fails;
    // that is a transient upstream problem, not a bad request.
    if (error.isRetryable) return upstreamUnavailable(withUpstreamDetail("Cursor is temporarily unavailable", error.message));
    return invalidRequest(error.message);
  }
  if (error instanceof CursorSdkError && (error.status === 408 || error.status === 504)) {
    return upstreamTimeout(withUpstreamDetail("Cursor request timed out", error.message));
  }
  if (error instanceof NetworkError) return upstreamUnavailable(withUpstreamDetail("Cannot reach Cursor", error.message));
  if (error instanceof CursorSdkError) {
    if (error.status === 401 || error.status === 403) return upstreamAuthError();
    if (error.status === 429) return rateLimitError(error.message || "Cursor usage limit exceeded");
    if ((error.status !== undefined && error.status >= 500) || error.isRetryable) return upstreamUnavailable(withUpstreamDetail("Cursor is temporarily unavailable", error.message));
    return upstreamError(withUpstreamDetail("Cursor request failed", error.message));
  }
  return upstreamError();
}

export function runFailureError(failure: { message: string; code?: string } | undefined): GatewayError {
  if (!failure) return upstreamError();
  logError("cursor run failed", {
    ...(failure.code ? { upstream_code: failure.code } : {}),
    upstream_message: scrubSecrets(failure.message).slice(0, 300),
  });
  const text = `${failure.code ?? ""} ${failure.message}`;
  if (/rate.?limit|resource.?exhausted|quota|usage.?limit|too.?many.?requests/i.test(text)) return rateLimitError(withUpstreamDetail("Cursor usage limit exceeded", failure.message));
  if (/unauthenticated|unauthori[sz]ed|invalid.?api.?key|permission.?denied/i.test(text)) return upstreamAuthError();
  if (/deadline.?exceeded|timed?.?out/i.test(text)) return upstreamTimeout(withUpstreamDetail("Cursor request timed out", failure.message));
  if (/unavailable|overloaded/i.test(text)) return upstreamUnavailable(withUpstreamDetail("Cursor is temporarily unavailable", failure.message));
  return upstreamError(withUpstreamDetail("Cursor request failed", failure.message));
}

function withUpstreamDetail(summary: string, detail: string | undefined): string {
  const trimmed = detail ? scrubSecrets(detail).trim() : undefined;
  return !trimmed || trimmed === summary ? summary : `${summary}: ${trimmed.slice(0, 300)}`;
}
