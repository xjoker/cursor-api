# Changelog

All notable changes to **cursor-api** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers use **`YYYYMMDD.N`** (date + same-day increment). The single source of truth is [`VERSION`](./VERSION).

**Setup & usage:** [`README.md`](./README.md) · [`README.zh-CN.md`](./README.zh-CN.md)

---

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
- Common OpenAI sampling fields accepted but not forwarded upstream.
- Tool calling is OpenAI-protocol only (client executes). Pending tool rounds live in memory and do not survive gateway restart.

---

## Release checklist (operators)

When cutting a release, update in one commit:

1. [`VERSION`](./VERSION) — run `date +%Y%m%d` for the date prefix.
2. This file — move `[Unreleased]` items into a dated section.
3. [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md) — only if setup or integration steps changed.
4. Docker tag / `/health` — confirm `version` and `git_commit` after deploy.

See [`README.md`](./README.md) for deploy commands.
