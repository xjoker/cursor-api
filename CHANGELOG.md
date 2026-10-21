# Changelog

All notable changes to **cursor-api** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers use **`YYYYMMDD.N`** (date + same-day increment). The single source of truth is [`VERSION`](./VERSION).

**Setup & usage:** [`README.md`](./README.md) · [`README.zh-CN.md`](./README.zh-CN.md)

---

## [20261021.2] — 2026-10-21

### Added

- 管理总览展示进程内存、Response 缓存条数与载荷、未完成 SDK 会话操作、运行时长，以及请求时限和退出宽限期；管理台提供双语状态说明和刷新入口。
- 总览上游检查最多等待 1.5 秒，超时仍返回本地状态；每个 Key 池共享一个有界检查结果，底层检查结束前不会重复发起或累计超时回调。

### Changed

- 网页管理请求限制为 15 秒，区分超时与取消，结束后清理计时器；瞬时网络失败保留已有凭据，写请求不自动重放。
- 补齐 WAL 数据库备份恢复边界，更新 schema 12 说明；配置和原有 pepper 必须与数据库配套恢复。

## [20261021.1] — 2026-10-21

### Added

- `request_timeout_ms` / `REQUEST_TIMEOUT_MS` 默认 300000，覆盖生成请求的正文读取、模型预检、SDK 操作和流式写入；0 关闭。超时返回 504 `request_timeout`，已开始的 SSE 返回对应协议错误终帧，客户端断连保持取消语义。
- SIGTERM/SIGINT 停止接收新请求，按 `shutdown_timeout_ms` / `SHUTDOWN_TIMEOUT_MS`（默认 10000）等待在途请求，再取消会话并有界清理；未完成清理明确记录并非零退出。Compose 停止宽限期为 30 秒。

### Changed

- 不可取消的 SDK 创建、发送及等待在超时后继续占用相应会话容量，迟到结果清理；发送结果未知时保守结算配额。工具停车续轮获得新的请求时限。
- Response 缓存按 UTF-8 JSON 字节保存，总计最多 32 MiB、每个 Key 最多 8 MiB，保留原有条数和一小时限制；读写先回收全局过期条目。单条超过 8 MiB 时正常返回但不缓存，后续 GET 返回 404；这些载荷上限不代表整个进程内存上限。

## [20261020.5] — 2026-10-20

### Added

- 请求日志独立保存上游 Agent 累计费用快照及其口径，无需开启正文日志；未知费用保留 null，显式零值保留 0。schema 12 为旧记录追加可空费用列，不回填或重写旧费用。
- 管理台展示 Key 剩余额度、重置时间与时区，策略表单增加输入校验、保存/重置忙碌状态和成功反馈；失败保留输入。请求详情明确费用快照可能延迟且不能相加作为请求费用。

### Changed

- 日志超过正文容量上限时按时间和稳定顺序批量删除最旧前缀，减少逐行删除造成的重复字节汇总；保留原有天数、行数和 UTF-8 字节上限。

## [20261020.4] — 2026-10-20

### Added

- 管理台总览展示当前生效的非敏感运行配置、完整提交和数据库 schema；概览 API 通过显式白名单返回 `settings`，仅管理员可读。
- 请求日志列表和详情显示 Max 模式三态，并提供常见失败原因的中英说明，保留原始错误码与上游详情。

## [20261020.3] — 2026-10-20

### Changed

- **BREAKING：支持范围收敛为 OpenAI 兼容接口**：保留 Chat Completions、Responses 和模型查询，移除 Anthropic Messages、count_tokens、专属配置及 Claude Code 接入说明；旧路由返回 404。

### Added

- `rate_limit_per_key` / `RATE_LIMIT_PER_KEY`：每个客户端 Key 的滚动 60 秒生成请求上限，默认 0 关闭；Chat 与 Responses 共用额度，流式请求计一次，工具续轮按新请求计数。超限返回 OpenAI 格式 429 和 `Retry-After`。状态仅在当前进程内保存，重启清空，多实例应配合反向代理限流。
- 使用官方 `openai@7.39.0` 开发依赖验收 Chat/Responses 非流式、流式 usage、工具往返、Response 读取及 SDK 错误解析；默认测试使用假 Cursor 上游与出网守卫。

## [20261020.2] — 2026-10-20

### Added

- 客户端 Key 支持模型白名单、请求与 Token 配额、每日/月度周期及并发上限；管理台可编辑策略、查看和重置本期用量。
- `allow_max_mode` 默认开启；关闭时限制 SDK 自动选择 max 变体，全局关闭是硬上限，Key 只能进一步收紧。SDK 已发送的 max run 只能取消，可能仍产生费用。
- `quota_cache_read_weight` 控制缓存读 Token 的配额权重，默认 1；准入预留参考最近 20 次 run 用量，可通过 `quota_reserve_recent_runs` 调整。
- Chat 支持 OpenRouter reasoning 对象与双字段推理输出；支持尽力而为的 JSON 输出格式，不保证合法 JSON 或 schema 合规。
- `enforce_output_limits` 默认关闭；开启后执行三协议输出长度和 stop 序列限制，Token 按每 4 字符估算，触发时取消上游 run。
- `GET /v1/responses/{id}` 按客户端 Key 隔离读取内存中的 Response；1 小时过期，每 Key 100 条、总计 1000 条，重启丢失，`store:false` 不保存。
- `history_resume` 默认关闭；开启后按 Key、user 和完整历史复用已完成的 agent，记录一次性使用，agent 忙时显式续接返回 409。未证实能节省上游计费 Token。

### Changed

- 升级 `@cursor/sdk` 至 1.0.38，新增模型变体 `is_max_mode`，可重试的目录配置错误返回 503。
- **BREAKING：OpenAI usage 输入包含缓存读写**，`prompt_tokens + completion_tokens = total_tokens`；Responses 同口径，Anthropic 保持未缓存输入与缓存分列。schema 11 会一次性改写旧请求日志的输入计数；回滚后旧行仍保留新口径。
- 推理档位采用模型可支持的相近档位；精确 variant / params 继续校验，软提示不会选中仅 max 可用的值。
- Token 配额是软上限：准入原子预留，run 未启动时退还，完成后按单次用量结算；中断、失败及缺少 usage 时计入估算，工具停车占用并发槽。冷启动及在途请求仍可能超额。

### Fixed

- 工具续接只采用实际选中会话的停车并发槽，显式其他会话不能绕过单 Key 并发限制。
- SDK 已派发但被 max-mode 策略拒绝时，取消 run 并清除该 Key 下指向该 agent 的全部会话映射，后续请求重新建会话。
- 请求和响应日志入库前递归脱敏，遮盖模型字段、上游错误和凭据形状；详细日志在截断前脱敏，仍应谨慎开启以保护普通提示词内容。
- 测试默认使用假 SDK 和出网守卫；Linux CI 使用空网络命名空间。临时目录检查同样保留守卫，新功能测试结束后回收临时目录。

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
- **Request log redaction (`request_logs`, admin log viewer).** `request_detail`, `response_detail` (including the `error_message` snapshot written even with `detailed = false`) and `model` now get the same masking as stdout and the system log before they are stored: bodies are redacted structurally before they are truncated to `detailed_max_bytes`, and `insertRequestLog` masks again as the last step (invalid or truncated JSON is scrubbed as text). Field names are checked too: a name that carries a credential shape, or whitespace plus a credential word (`Bearer token_abc <secret>`, `password <secret>`), is replaced whole by `[redacted]`, so a secret sent as an unknown field name is not kept. Bodies get in-place masking only (no whole-value fallback), so prompts that merely mention a credential word stay readable. The stored `error_message` is the exception: like upstream error text in the system log, it is checked on its raw text and stored as `[redacted]` when it contains a credential word (`Bearer token_abc <secret>`, `password <secret>`). Nested objects and arrays are walked in both sinks (depth-capped, cycle-safe). New shapes masked in place: standalone JWTs, `ghp_…`/`github_pat_…`, `AKIA…`/`ASIA…`, URL userinfo passwords (`https://user:[redacted]@host`), `X-Management-Key: …`, `Cookie:`/`Set-Cookie:` header values, short `Bearer` values with a digit or symbol, JSON-escaped `\n` after `Bearer`/`Authorization:`, prefixed `HTTP_AUTHORIZATION:`/`x_authorization=`, plural and `passphrase`/`admin_key`/`cursor_key` names, and values that only start like `null`/`true`/`[redacted]`. Now readable: `page_token`/`pageToken` cursors, `prompt_cache_key`, `idempotency_key`, `Basic` followed by a short word (`Basic Auth0`), and plural count values such as `max_tokens: 4096`. `*_key` / bare `key` field names are credentials. Existing rows are not rewritten.

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
