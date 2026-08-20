/**
 * Shared contracts for the MVP gateway.
 * Implementations live in the owner files listed below. Do not add new files.
 */

export interface AppConfig {
  cursorApiKey: string;
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
}

export interface LogPolicy {
  retentionDays: number;
  maxRows: number;
  /** Cap total UTF-8 bytes of request_detail + response_detail across all rows. */
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
  error_code: string | null;
  created_at: string;
  upstream_ms: number | null;
  gateway_ms: number | null;
  request_detail: string | null;
  response_detail: string | null;
  has_detail?: boolean;
  key_name?: string | null;
  key_prefix?: string | null;
}

export interface TokenTotals {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  unknown_usage_count: number;
}

export interface ModelTokenRow extends TokenTotals {
  model: string;
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

export interface ParsedChatMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
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
  verbosity?: string;
  fast?: string;
  optimize_for?: string;
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
}
