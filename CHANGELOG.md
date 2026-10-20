# Changelog

All notable changes to **cursor-api** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers use **`YYYYMMDD.N`** (date + same-day increment). The single source of truth is [`VERSION`](./VERSION).

**Setup & usage:** [`README.md`](./README.md) · [`README.zh-CN.md`](./README.zh-CN.md)

---

## [Unreleased]

### Changed

- 升级 `@cursor/sdk` 至 1.0.38。`zod` 改为 SDK 的 peer 依赖（npm 自动安装，无需手动添加）。
- **Max mode 计费提示**：新版 SDK 只要「与 params 匹配的目录变体全部是 max-only」就会自动以 max mode 发送；调用方显式传 `maxMode: false` 会被 SDK 覆盖。网关以默认变体参数为基础，所以默认变体是 max-only 的模型只写模型名也会走 max（默认行为保持不变）。
- 1.0.38 每次 send 都会按目录解析模型；目录暂时不可用时抛出的可重试 `ConfigurationError` 现在映射为 `503 upstream_unavailable`（原来是 400）。

### Added

- `allow_max_mode`（`ALLOW_MAX_MODE`，默认 `true`）：设为 `false` 时网关按 SDK 的同一规则检测 max mode，自动换成非 max 变体，无法换时返回 `403 max_mode_not_allowed`（覆盖 `params`、`variant`、`reasoning_effort`、Anthropic `output_config.effort`、模型别名、续会话和换 Key 重试）。
- `allow_max_mode=false` 加固（Elliot 第 2 轮审查）：只在 max 变体里出现的参数值（如 `context=1m` 混搭 `reasoning_effort=low`）一律 `403`，不再原样放行；`Agent.create`/`resume`/`send` 后检查 SDK 实际解析的 `agent.model` / `run.model`，是 max 就释放 agent / 取消 run 并 403（禁用时流式输出会等这一步检查完再开始）；回退变体同分时按参数字典序决定，不依赖目录顺序；软提示被丢弃时写日志；设置了 `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` 时启动告警。
- Max mode 第 4 轮（Elliot 第 3 轮审查）：
  - `params` 按目录规范值转发（`1M`、`"1m context"` → `1m`），max-only 检查也不区分大小写。
  - resume 路径上 send 阶段被拦不再重放（避免 max 请求发 2 次）。
  - send 阶段被拦的请求日志记 `max_mode=1`；文档写明 send 阶段只能「发出后取消」。
- 请求日志新增 `max_mode` 列（记录 SDK 实际解析值）（1/0，未跑到 run 时为空），`GET /admin/api/logs` 返回该字段；系统日志 `chat/messages/responses completed` 带 `max_mode`。
- `/v1/models` 的 `variants[]` 对仅支持 max mode 的变体返回 `is_max_mode: true`。

---

## [20261020.1] — 2026-10-20

### Added

- 集成 Anthropic Messages、Claude Code 工具往返、模型别名和推理档位支持；本地 token 估算需显式开启，默认返回 404。
- 集成 Cursor 多 Key 轮换、冷却、故障切换、least_active 策略及管理台状态面板。

### Fixed

- 会话及 Responses 续接绑定原上游 Key，持久化仅保存指纹；跨账号模型验证与运行使用同一 Key。
- 工具续接参与 Key 池负载统计；已向客户端输出内容后停止故障切换。
- Anthropic 限流错误保留 Retry-After 响应头。

### Changed (BREAKING)

- **The default listen address is now `127.0.0.1`.** Previously `NODE_ENV=production` without a `host` defaulted to `0.0.0.0`. Affected: anyone reaching the gateway from another machine while running without Docker under `NODE_ENV=production` (PM2, systemd, …) with no `host` in `gateway.toml` and no `GATEWAY_HOST`, and custom container images that do not use this repo's `Dockerfile`. Symptom after upgrade: `curl http://127.0.0.1:8787/health` works locally, other machines get *connection refused*. Check with `ss -ltnp | grep 8787` (`127.0.0.1:8787` means affected). To restore LAN access, add `host = "0.0.0.0"` to `gateway.toml` or set `GATEWAY_HOST=0.0.0.0` (PM2 ecosystem `env` / systemd `Environment=`) and restart. Risk: `0.0.0.0` exposes the gateway, and with it your Cursor account, to every network the host is on; only do it behind a firewall or reverse proxy. Not affected: the official image and compose files (still `0.0.0.0` inside the container), and configs that already contain `host = "0.0.0.0"` (including ones auto-created by older releases). See README → *Upgrading: listen address*.
- Listen address priority is now `GATEWAY_HOST` → `gateway.toml` `host` → `GATEWAY_DEFAULT_HOST` → `127.0.0.1`. The Docker image sets `GATEWAY_DEFAULT_HOST=0.0.0.0` (not `GATEWAY_HOST`), so a `host` in a mounted `gateway.toml` is honoured inside the container. A warning is logged when `GATEWAY_HOST` overrides a different `host` from `gateway.toml`.
- The auto-created `gateway.toml` and `gateway.toml.example` no longer pin `host = "0.0.0.0"`; the line is commented out.

### Changed

- **Log redaction (stdout/stderr and the admin system log).** Now readable: token counts under the exact count field names (`input_tokens`, `output_tokens`, `total_tokens`, `prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `cached_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `max_tokens`, `max_output_tokens`, `max_completion_tokens`, `budget_tokens`, `token_count`, `prompt_token_count`, in snake_case, camelCase or kebab-case) when the value is a number or null, and the `*_tokens_details` usage objects when they are plain objects (walked, so their own credential fields are still masked; an array or string there is masked); `api_key_id` and `api_key_name`. The names `key_prefix` and `api_key_prefix` are not treated as credentials, but their values are still scrubbed, so a real 12-character `cgk_…` key prefix is shown as `[redacted]`. Error text whose only credential word is an exact count phrase stays readable only when the phrase is followed by the end of the text, a number or `null` (optionally after `:`/`=`, quotes or closing punctuation, and again followed by one of these), or one of the words `must`, `should`, `cannot`, `exceed(s/ed)`, `limit`, `of`, `maximum`, `is too` (`max_tokens must be …`, `max_tokens: 4096`, `210000 tokens > 200000 maximum`); anything else after the phrase (`max_tokens=9abc`, `max_tokens: 1 abc`, `max_tokens is abc`, a newline, `->`, `(`, `/`) masks the value whole. Still masked: any other field whose name contains `token`, `secret`, `password`, `passwd`, `api_key`, `access_key`, `private_key`, `authorization`, `cookie`, `pepper`, `credential`, `bearer` or `jwt` (camelCase, kebab-case and plural included, e.g. `accessToken`, `refresh_tokens`, `idTokens`), whatever the value type; a count field name with a non-numeric value; string values whose raw text contains `token`, `secret`, `password`, `passwd`, `api_key`, `authorization`, `pepper`, `cookie` or `credential` outside such a count phrase (and a count phrase does not excuse a value that also contains a 16+ character letter-and-digit run). New: the log message is scrubbed too — `Bearer …`, `Basic <base64>`, `cgk_…`, `sk-…`, Cursor session tokens (`user_…::…`), `Authorization: <scheme> …` and `name=value` / `"name":"value"` forms such as `access_token=`, `client_secret:` or `password=` are masked in place. Log messages and string field values longer than 16 384 characters are cut (at a word break, marked `…[truncated]`) before redaction; a cut field value is masked whole when its full original text contains one of the credential words above anywhere, including past the cut (no count-phrase exception). The redaction work is linear in the input size and does not throw on multi-megabyte input. Upstream Cursor error text (`upstream_message` in `cursor run failed`, and the detail appended to gateway error messages, which is also logged as `error_message`) gets the same raw-text check before it is logged or returned: if it contains a credential word, the detail is replaced by `[redacted]`, so clients now see e.g. `Cursor request failed: [redacted]` instead of the scrubbed upstream text. A log line that cannot be serialized (BigInt, circular or throwing fields) is written as `{"message":"[redacted]","log_format_error":true}` instead of throwing.

---

## [20261016.1] — 2026-10-16

### Changed

- 升级 `@cursor/sdk` 至 1.0.37、TypeScript 至 7.0.2、Node 22 类型至 22.20.5；撤销已不再需要的 `undici` 覆盖。
- CI 增加 PR 校验、Node 22.13 / 22 / 24 测试和 amd64 容器健康检查；更新官方 Actions，发布构建禁用缓存。
- 限制运行与停车会话数量，定期清理过期会话映射；新配置见双语 README。

### Fixed

- 无状态 Responses 工具回合可续接停车会话；`reasoning.effort` 按模型支持档位映射。
- 工具回合生成的 response ID 持久化供后续恢复；数据库写失败时释放已创建或恢复的 Agent 及容量占位。
- SSE 立即发送响应头并维持心跳；上游失败区分认证、限流、忙碌、不可用和超时，保留诊断信息。
- 可选忽略 Chat Completions 采样参数，默认保持严格校验。

### Security

- 认证失败达到每地址窗口上限后拒绝凭据校验，响应附带 `Retry-After`；管理页禁止嵌入。
- 日志保留 token 数量并递归遮盖嵌套对象、数组及消息中的凭据。
- CORS 支持精确来源白名单及关闭模式，默认通配响应不再回显任意来源。

### Documentation

- [维护评估](docs/maintenance-20261016.md)记录现有 issue / PR 的处理结果、官方 SDK 核验依据与验证边界。

---

## [20260903.1] — 2026-09-03

### Fixed

- `npm run dev` compiles with `tsc` then runs `dist/`, so Node16 `.js` import specifiers resolve instead of failing under `--experimental-strip-types`.

---

## [20260830.1] — 2026-08-30

### Fixed

- Concurrent requests for one `conversation_id` now return 409 instead of sharing and overwriting a live Cursor run.
- Parked tool sessions include image identity in their transcript hash, and an explicit `conversation_id` is authoritative during continuation routing.
- Detailed-log storage limits count UTF-8 bytes rather than Unicode characters.
- The no-clone Docker setup creates `./data` before the bind mount is started.

### Changed

- Unknown chat model IDs return `model_not_found` before an SSE response begins.
- `conversation_id` is limited to 512 UTF-8 bytes; each client key retains its newest 1,000 persisted agent mappings.

### Security

- Documented that the Cursor SDK accepts one prompt per turn, so serialized OpenAI `system` / `developer` roles are not a hard trust boundary.
- Overrode ConnectRPC's transitive `undici` dependency to 6.28.0, clearing the known HIGH and MODERATE advisories while retaining its `Headers` API usage.

### Tests

- Added loopback HTTP coverage for health, client-key enforcement, disabled keys, and admin authentication.
- Consolidated overlapping unit tests and replaced a 1,001-write fixture with one boundary write.

---

## [20260828.10] — 2026-08-28

### Documentation

- Removed the outdated admin overview screenshot (`docs/images/admin-overview.png`, UI from `20260820.4`).

---

## [20260828.9] — 2026-08-28

### Documentation

- Client docs split Codex (`POST /v1/responses`, `/compact`) from OpenCode and Chat Completions.
- `/health` upgrade check: compare `version` / `git_commit` after pull; a registry push does not update a running container.
- Document `park_timeout_ms` in README config tables and `gateway.toml.example`.
- Remove the duplicated OpenCode sentence in `README.md`.

---

## [20260828.8] — 2026-08-28

### Fixed

- Responses accepts Codex `/compact` requests that send `parallel_tool_calls: false` and `tools: []`. Chat Completions still 400s `parallel_tool_calls: false`.

---

## [20260828.7] — 2026-08-28

### Fixed

- Responses tool-result rounds no longer 400 when Codex replays assistant text, `function_call` items, skipped `reasoning`, and `function_call_output` in that order. Those items collapse into one Chat Completions assistant message with `tool_calls`, then the tool results.

---

## [20260828.6] — 2026-08-28

### Fixed

- Responses maps Codex `custom` tools (`apply_patch`) to Chat Completions functions with a `content` string schema (grammar copied into the description), then emits `custom_tool_call` / `input` and SSE `response.custom_tool_call_input.*` on the way back. Nested `namespace` tools flatten; unnamed hosted tools (`web_search`, …) are dropped. Chat Completions still requires `type: "function"`.

---

## [20260828.5] — 2026-08-28

### Fixed

- Responses no longer 400s unknown top-level fields (`client_metadata` from Codex, and similar SDK extras). Hosted tools (`web_search`, …) still 400. Chat Completions stays strict.
- Parse/validation failures now keep the incoming JSON in request logs when `[logs] detailed = true`, and always store `error_message` on 400/5xx so the admin request-detail view is not empty. Rows logged before this fix stay empty; the detail modal no longer tells you to enable `detailed` when it is already on.
- System log Fields column wraps and pretty-prints JSON; click a row to open the full payload.

---

## [20260828.4] — 2026-08-28

### Added

- `POST /v1/responses` for OpenAI Responses API clients (Codex, OpenCode with `@ai-sdk/openai`). Maps `input` / `instructions` / `function_call` items onto the existing Chat Completions turn, and streams typed SSE events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`). `previous_response_id` resumes the same Cursor agent. Hosted tools (`web_search`, …) 400; sampling knobs are accepted and ignored.

---

## [20260828.3] — 2026-08-28

### Changed

- `@cursor/sdk` 1.0.28 → 1.0.30. No gateway API changes: `customTools` / `tools: ["mcp"]` / `getUsage()` still typecheck, and Chat Completions tools have no `outputSchema` field to forward.

## [20260828.2] — 2026-08-28

### Fixed

- Request-log disk cap now counts UTF-8 bytes of `model` plus detail columns, and truncates `model` to 256 bytes so a client key cannot grow SQLite past `[logs].max_detail_bytes` (#3).
## [20260828.1] — 2026-08-28

### Fixed

- Failed Cursor runs now release their live session instead of leaving `conversation_id` pinned to a dead agent.
- Tool-result batches are validated before any parked call resumes, so duplicate or unknown IDs cannot partially consume a round.
- Stream requests validate tool choice before opening SSE; non-stream multi-tool rounds no longer repeat prior text.
- Unsupported `tool_choice: "required"` and `parallel_tool_calls: false` return 400 instead of being silently misrepresented.

## [20260827.8] — 2026-08-27

### Added

- Pending tool rounds: `park_timeout_ms` / `PARK_TIMEOUT_MS` (default 5 minutes). If the in-memory park is gone (gateway restart), the next `role: tool` request replays the full `messages` transcript on a new agent instead of 400 `No pending tool calls`.
- `conversation_id` (or `metadata.conversation_id`) reuses the same Cursor agent: in-process `send` of only the new user line, or `Agent.resume` after restart. Isolated per client key.
- `tool_choice: {type:"function", function:{name}}` registers only that client tool.
- `/health` `git_commit` falls back to `.git/HEAD` when `GIT_COMMIT` is unset.

### Fixed

- Vision attaches only images from the last user message, not every historical image.
- Sampling knobs with no Cursor equivalent (`temperature`, `top_p`, `seed`, …) now 400 instead of being silently dropped. OpenCode’s `max_tokens` is still accepted.

## [20260827.7] — 2026-08-27

### Added

- Chat Completions vision accepts OpenCode/AI SDK `image` and image `file` parts in addition to OpenAI `image_url` (`data:` and http(s)). Non-image files and audio stay rejected. `reasoning` content parts are ignored.
- Streaming `thinking-delta` from Cursor is forwarded as OpenAI-compatible `delta.reasoning_content` (and on non-stream `message.reasoning_content`) so OpenCode `--thinking` can render thinking blocks.

## [20260827.6] — 2026-08-27

### Added

- Admin overview shows a 7-day UTC call chart (`calls_by_day` on `GET /admin/api/overview`).
- System logs: `logInfo` / `logError` still go to stdout/stderr, and are also stored in SQLite (`GET /admin/api/system-logs`). Secrets stay redacted.
- Client keys can be deleted (`DELETE /admin/api/keys/{id}`). Request logs for that key remain.

## [20260827.5] — 2026-08-27

### Fixed

- `variant` now matches Cursor effort/reasoning/fast values when every catalog variant shares the same display name (Grok, Claude, GPT, …). `variant: "high"` sets effort/reasoning to high and keeps the default `fast` flag; unknown names 400 with `low, medium, high, fast` instead of repeating “Cursor Grok 4.5”. OpenCode `--variant` still does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the Chat Completions body.

## [20260827.4] — 2026-08-27

### Fixed

- Follow-up user turns no longer reuse an idle Cursor agent keyed only by shared message prefix. Two OpenCode sessions that both start with the same “Reply OK” (or any identical stem) were attaching the next user line to the other session’s agent, so secrets leaked across conversations. Each user turn now builds a new agent from the HTTP `messages` transcript. Pending tool rounds still keep the same in-memory agent.

## [20260827.3] — 2026-08-27

### Fixed

- Tool-result rounds only require results for `tool_calls` already sent on the wire. A second Cursor custom-tool park after the first flush no longer 400s (`Missing tool results`); leftover parks are returned on the next hop. Flush is debounced 50ms so true parallel calls still batch.

## [20260827.2] — 2026-08-27

### Fixed

- OpenAI `tools` now reach the model: Cursor `customTools` are an MCP family, so the local agent allows only `mcp` when client tools are present. `tools: []` had disabled MCP and the model never emitted `tool_calls`. Shell/read/edit stay off.
- `tool_call_id` is sanitized to OpenAI-safe `[A-Za-z0-9_-]` (Cursor MCP ids can contain newlines).

## [20260827.1] — 2026-08-27

OpenAI tool calling for local clients such as OpenCode.

### Added

- `POST /v1/chat/completions` accepts `tools` / `tool_choice` and `messages[].role=tool`.
- Assistant responses may include OpenAI `tool_calls` (`finish_reason: tool_calls`); the next request supplies tool results.
- Conversation reuse: the same Cursor agent is kept for follow-up user turns and pending tool rounds (in-memory; pending tools expire after 5 minutes).
- Request body limit raised to 4MiB so OpenCode system + tool schemas fit.

### Changed

- Cursor built-in shell/file tools stay disabled. When the client sends OpenAI `tools`, only MCP (`custom-user-tools`) is allowed so those callbacks can park; otherwise the toolset is empty. Client tools run on the client, not in the gateway workspace.

---

## [20260820.4] — 2026-08-20

Admin bilingual UI, per-key token/cache stats, and English-only docs hygiene.

### Added

- Admin UI bilingual: default English; browser `zh*` (incl. Traditional Chinese) selects Chinese; EN / 中文 toggle with `localStorage` override.
- Persist `cache_read_tokens` / `cache_write_tokens` / `reasoning_tokens` on request logs (schema v4).
- Per-key token and cache-read totals on `GET /admin/api/keys` and admin key table.

### Changed

- English docs (`README.md`, `CHANGELOG.md`, `.env.example`) no longer mix Chinese prose; Chinese readers use `README.zh-CN.md`.

---

## [20260820.3] — 2026-08-20

OpenAI chat contract fixes for cancelled runs and unknown usage.

### Fixed

- Non-stream chat: upstream `cancelled` now returns HTTP 499 OpenAI error instead of 200 + `finish_reason: stop` (#1).
- Stream chat: upstream `cancelled` writes SSE error + `[DONE]` and ends the response (#1).
- Non-stream chat: omit `usage` when upstream did not report token usage (`usageKnown=false`) (#2).

---

## [20260820.2] — 2026-08-20

Detailed request logs (opt-in), admin modal, disk/latency hardening, and review fixes.

### Added

- `[logs]` detailed request/response capture (default off), admin log modal, upstream/gateway latency split.
- `[logs].max_detail_bytes` caps total detail-column size (default 256MiB); SQLite/WAL chmod `600`.
- `[logs]` in `gateway.toml`: `retention_days` (default **7**), `max_rows`, compose `logging.options`.
- README deploy path: paste inline `docker-compose.yml` (GHCR `latest`); no clone required.
- GitHub Actions **Release** workflow: tests + GHCR push on version tags or manual dispatch only.
- Admin clipboard fallback for HTTP (non-secure contexts).
- README screenshot: `docs/images/admin-overview.png`.

### Changed

- Standard compose service name: `cursor-api` (was `gateway`); upgrade with `docker compose down --remove-orphans`.
- Config parse errors name the source (`environment variable …` vs `gateway.toml key …`).
- `truncateUtf8` for detailed logs is O(n) byte-safe (fixes event-loop DoS when `detailed = true`).

### Fixed

- HTTP admin “copy key” failed without HTTPS — fall back to `execCommand("copy")`.
- Log detail modal focus trap / restore focus / `inert` on background.

---

## [20260820.1] — 2026-08-20

Deploy-focused release: one on-disk config file, TOML-based secrets, docs, and container bootstrap.

### Added

- Single config file [`data/config/gateway.toml`](./data/config/gateway.toml.example) (listen + secrets).
- Example template: `data/config/gateway.toml.example`.
- Minimal TOML loader with tests for inline `#` comments and `#` inside quoted strings.
- `npm test` script and `tests/gateway.test.mjs`.
- Compose `GATEWAY_UID` / `GATEWAY_GID` for Linux bind-mount permission alignment.
- `.env` loader for local dev (env vars still override `.env` and TOML).
- **Docker bootstrap:** auto-create empty `gateway.toml` on first start when `NODE_ENV=production` and the file is missing.
- Bilingual docs: [`README.md`](./README.md), [`README.zh-CN.md`](./README.zh-CN.md), this changelog.

### Changed

- **Breaking (deploy):** one `gateway.toml` replaces separate `secrets.toml` + split gateway settings.
- Docker Compose no longer injects secrets via `env_file` / `environment`.
- Dockerfile: `GIT_COMMIT` build arg; production default listen `0.0.0.0:8787`.
- Config priority: **environment → `.env` → TOML → defaults**.
- `loadDotEnv()` runs before `loadConfig()`.
- Stricter validation: `stream` must be a JSON boolean when present.
- Request handling: unhandled error guard, invalid `Host` rejection, SSE abort on client disconnect.

### Fixed

- TOML trailing comments and `#` inside quoted strings parse correctly.

### Documentation

- `temp/` added to `.gitignore` (local design drafts only).

---

## [20260819.1] — 2026-08-19

Initial public MVP.

### Added

- OpenAI-compatible HTTP gateway on top of `@cursor/sdk`:
  - `POST /v1/chat/completions` (streaming and non-streaming)
  - `POST /v1/responses` (OpenAI Responses API; streaming and non-streaming)
  - `GET /v1/models`, `GET /v1/models/{id}`
  - CORS `OPTIONS` on `/v1/*`
- Client API keys (`cgk_…`) with HMAC-SHA256 digests and enable/disable.
- Admin REST API (`/admin/api/*`) and web console (`/admin/`):
  - Overview metrics
  - Client key management
  - Request log browsing with time-range filters and pagination
- SQLite persistence for keys and request logs (`schema_version` 2).
- Vision input via OpenAI `image_url` parts (`data:` and remote URLs).
- Cursor model metadata, billing hints (`cursor.cost`), and forwarded Cursor params.
- `GET /health`, JSON discovery at `GET /`, browser redirect from `/` to `/admin/`.
- Docker multi-stage image (`linux/amd64`, `TZ=UTC`) and `docker-compose.yml`.
- TypeScript source, `npm run dev` / `build` / `typecheck`.

### Security

- Upstream auth uses a single Cursor User API Key; no browser OAuth in MVP.
- Admin and client credentials use separate secrets and headers.

### Known limitations (MVP)

- Single upstream Cursor account only.
- No audio, Claude `/v1/messages`, or Gemini APIs.
- No Cursor account balance endpoint (Enterprise Admin APIs not integrated).
- Common OpenAI sampling fields (`temperature`, `top_p`, `seed`, …) 400; `max_tokens` is accepted but not forwarded.
- Tool parking is in-memory. After a gateway restart, the next tool-result request continues from the HTTP transcript instead of the original Cursor run.
- `conversation_id` is required to resume the same Cursor agent across user turns. OpenCode does not send it by default.

---

## Release checklist (operators)

When cutting a release, update in one commit:

1. [`VERSION`](./VERSION) — run `date +%Y%m%d` for the date prefix.
2. This file — move `[Unreleased]` items into a dated section.
3. [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md) — only if setup or integration steps changed.
4. Docker tag / `/health` — confirm `version` and `git_commit` after deploy.

See [`README.md`](./README.md) for deploy commands.
