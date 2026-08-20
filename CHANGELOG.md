# Changelog

All notable changes to **cursor-api** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers use **`YYYYMMDD.N`** (date + same-day increment). The single source of truth is [`VERSION`](./VERSION).

**Setup & usage:** [`README.md`](./README.md) · [`README.zh-CN.md`](./README.zh-CN.md)

---

## [Unreleased]

### Added

- `[logs]` in `gateway.toml`: `retention_days` (1–3650) and `max_rows` (1k–10M) cap SQLite request logs; oldest rows deleted first.
- Compose `logging.options` (`max-size` / `max-file`) to cap container stdout disk use.
- README deploy path: paste inline `docker-compose.yml` (GHCR `latest`); no clone required.
- GitHub Actions **Release** workflow: tests + GHCR push on version tags or manual dispatch only.

### Changed

- Standard compose service name: `cursor-api` (was `gateway`).

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
- No tool / function calling, audio, Claude `/v1/messages`, or Gemini APIs.
- No Cursor account balance endpoint (Enterprise Admin APIs not integrated).
- Common OpenAI sampling fields accepted but not forwarded upstream.

---

## Release checklist (operators)

When cutting a release, update in one commit:

1. [`VERSION`](./VERSION) — run `date +%Y%m%d` for the date prefix.
2. This file — move `[Unreleased]` items into a dated section.
3. [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md) — only if setup or integration steps changed.
4. Docker tag / `/health` — confirm `version` and `git_commit` after deploy.

See [`README.md`](./README.md) for deploy commands.

---

## 变更说明（中文摘要）

| 版本 | 要点 |
|------|------|
| **20260820.1** | 配置合并为单个 `gateway.toml`；容器可自动创建空配置；TOML 部署、双语文档、测试与 Compose UID 说明。 |
| **20260819.1** | 首个 MVP：OpenAI 兼容 Chat、客户端 Key、管理台、请求日志、Docker 部署。 |

完整英文条目见各版本节；使用说明见 [`README.md`](./README.md) / [`README.zh-CN.md`](./README.zh-CN.md).
