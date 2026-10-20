/**
 * Shared contracts for the gateway.
 * Chat completions + OpenAI tool calling live in openai.ts / session.ts / cursor.ts.
 */

export interface AppConfig {
  corsAllowOrigins: string[];
  /** `POST /v1/messages/count_tokens`: rough local estimate, or 404 when off. */
  anthropicCountTokens: "estimate" | "off";
  /** `model_aliases` rules applied to every request's `model` before catalog lookup. */
  modelAliases: Array<{ pattern: string; target: string; matcher: RegExp }>;
  cursorApiKey: string;
  /** Upstream key pool (`cursor_api_key` + `cursor_api_keys`), deduplicated, at least one. */
  cursorApiKeys: string[];
  /** Cooldown after an upstream rate limit before a key is tried again. */
  cursorKeyCooldownMs: number;
  /** Key selection: `round_robin` (default) or `least_active`. */
  cursorKeyStrategy: "round_robin" | "least_active";
  gatewayHost: string;
  gatewayPort: number;
  adminAccessKey: string;
  apiKeyPepper: string;
  dataDir: string;
  cursorWorkspace: string;
  version: string;
  gitCommit: string;
  maxBodyBytes: number;
  logRetentionDays: number;
  logMaxRows: number;
  logDetailed: boolean;
  logDetailedMaxBytes: number;
  logMaxDetailBytes: number;
  parkTimeoutMs: number;
  /** Unsupported Chat Completions sampling knobs are dropped instead of rejected. */
  ignoreSamplingParams: boolean;
  /**
   * Allow requests that resolve to a Cursor max-mode variant (SDK >= 1.0.38 turns max mode on
   * automatically for those). When false the gateway picks a non-max variant or rejects.
   */
  allowMaxMode: boolean;
  /** Weight (0..1) of cache-read tokens in per-key token quotas; per-key value overrides. */
  quotaCacheReadWeight: number;
  /** SSE comment heartbeat interval while a stream is open; 0 disables it. */
  sseKeepaliveMs: number;
  /** Failed authentication attempts allowed per address each minute; 0 disables throttling. */
  authFailureLimit: number;
  /** Upper bound on in-memory Cursor sessions (running or parked for tool results). */
  maxLiveSessions: number;
  /** Days a conversation_id → agent mapping survives without use. */
  conversationTtlDays: number;
  /** Reverse proxies whose X-Forwarded-For is trusted. */
  trustedProxies: string[];
}

export interface LogPolicy {
  retentionDays: number;
  maxRows: number;
  /** Cap total UTF-8 bytes of model + request_detail + response_detail across all rows. */
  maxDetailBytes: number;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_digest: string;
  enabled: number;
  request_limit: number;
  used_requests: number;
  created_at: string;
  updated_at: string;
  /** Allowed model patterns (exact id or `*` glob, case-insensitive). `null` = unrestricted, `[]` = none. */
  allowed_models: string[] | null;
  /**
   * Per-key max-mode restriction: `null` = inherit the gateway `allow_max_mode` (default true),
   * `false` = never run max-mode variants (non-max fallback or 403). The gateway setting is a hard
   * ceiling: effective = gateway AND key, so `true` cannot enable max mode when the gateway is false.
   */
  allow_max_mode: boolean | null;
  /** Requests allowed per quota period. `null` = unlimited. */
  quota_requests: number | null;
  /** `total_tokens` allowed per quota period (soft cap). `null` = unlimited. */
  quota_tokens: number | null;
  quota_period: QuotaPeriod;
  /** IANA time zone used to cut daily / monthly periods. */
  quota_tz: string;
  /** Max in-flight requests for this key. `null` = unlimited. */
  max_concurrent: number | null;
  /** Weight (0..1) of cache-read tokens in `quota_tokens`; `null` = gateway `quota_cache_read_weight`. */
  quota_cache_read_weight: number | null;
}

export type QuotaPeriod = "total" | "daily" | "monthly";

/** Policy fields that govern which models / variants a client key may use. */
export interface KeyModelPolicy {
  allowedModels: string[] | null;
  allowMaxMode: boolean | null;
}

export interface KeyUsageRow {
  api_key_id: string;
  period_start: string;
  requests: number;
  tokens: number;
  updated_at: string;
}

export interface RequestLogQuery {
  limit: number;
  offset: number;
  model?: string;
  api_key_id?: string;
  http_status?: number;
  from?: string;
  to?: string;
}

export interface SystemLogRow {
  id: string;
  level: string;
  message: string;
  fields: string | null;
  created_at: string;
}

export interface SystemLogQuery {
  limit: number;
  offset: number;
  level?: string;
}

export interface RequestLogFilters {
  models: string[];
  keys: Array<{ id: string; name: string | null; key_prefix: string | null }>;
  statuses: number[];
}

export interface RequestLogRow {
  id: string;
  api_key_id: string;
  path: string;
  model: string;
  stream: number;
  http_status: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  error_code: string | null;
  created_at: string;
  upstream_ms: number | null;
  gateway_ms: number | null;
  request_detail: string | null;
  response_detail: string | null;
  /** 1 = run used Cursor max mode, 0 = not, null = unknown (no run / legacy row). */
  max_mode?: number | null;
  has_detail?: boolean;
  key_name?: string | null;
  key_prefix?: string | null;
}

export interface TokenTotals {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  unknown_usage_count: number;
}

export interface ModelTokenRow extends TokenTotals {
  model: string;
}

export interface KeyTokenRow extends TokenTotals {
  api_key_id: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export interface CursorCost {
  raw_cost_cents: number;
  charged_cents: number;
}

export interface ModelParam {
  id: string;
  value: string;
}

export interface OpenAiToolFunction {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface OpenAiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ParsedChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
  images?: ParsedImage[];
}

export type ParsedImage =
  | { url: string }
  | { data: string; mimeType: string };

export interface ParsedChatRequest {
  model: string;
  messages: ParsedChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  images?: ParsedImage[];
  params?: ModelParam[];
  variant?: string;
  reasoning_effort?: string;
  /**
   * Best-effort reasoning level from clients that always send one (Responses
   * `reasoning.effort`, Anthropic `thinking` / `output_config.effort`). Applied
   * only when the model has an effort parameter; never causes a 400.
   */
  reasoning_effort_hint?: string;
  verbosity?: string;
  fast?: string;
  optimize_for?: string;
  tools?: OpenAiToolFunction[];
  /** Responses `type: "custom"` names; output 发 `custom_tool_call` 而不是 `function_call`。 */
  customToolNames?: string[];
  tool_choice?: "auto" | "none" | { name: string };
  conversation_id?: string;
  /** The gateway assigned the conversation ID, so transcript matching remains valid. */
  conversation_id_generated?: boolean;
}

export interface OpenAiModel {
  id: string;
  object: "model";
  created: number;
  owned_by: "cursor";
  display_name: string;
  description?: string;
  aliases?: string[];
  parameters?: Array<{
    id: string;
    display_name?: string;
    values: Array<{ value: string; display_name?: string }>;
  }>;
  variants?: Array<{
    display_name: string;
    description?: string;
    is_default?: boolean;
    /** True when Cursor only runs this variant in max mode (reported by newer Cursor SDKs). */
    is_max_mode?: boolean;
    params: ModelParam[];
  }>;
}

export interface CursorChatResult {
  text: string;
  usage: Usage;
  usageKnown: boolean;
  cost?: CursorCost | null;
  params?: ModelParam[];
  status: "finished" | "error" | "cancelled";
  finish_reason: "stop" | "tool_calls" | "cancelled" | "error";
  error?: { message: string; code?: string };
  tool_calls?: OpenAiToolCall[];
  /** Cursor `thinking-delta` text; OpenCode reads this as `reasoning_content`. */
  reasoning?: string;
  /** True when the run was sent with Cursor max mode (billed at max rates). */
  max_mode?: boolean;
  /**
   * Where `usage` came from: `run` = this run only (`run.wait().usage`),
   * `agent_total` = cumulative `agent.getUsage()` fallback (may include earlier turns).
   */
  usageScope?: "run" | "agent_total";
  /**
   * Gateway estimate (~4 chars/token) of this HTTP turn's tokens: input sent upstream plus streamed
   * text, thinking and tool-call arguments. Charged to `quota_tokens` when no run-scoped usage is
   * known (client abort, tool-call suspension, cumulative-only usage).
   */
  quota_estimate_tokens?: number;
  /** Tokens already charged for earlier tool-call rounds of the same run (subtracted from run usage). */
  quota_precharged_tokens?: number;
}
