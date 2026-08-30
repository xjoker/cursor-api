# Changelog

All notable changes to **cursor-api** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers use **`YYYYMMDD.N`** (date + same-day increment). The single source of truth is [`VERSION`](./VERSION).

**Setup & usage:** [`README.md`](./README.md) · [`README.zh-CN.md`](./README.zh-CN.md)

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
