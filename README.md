# cursor-api

Minimal **OpenAI-compatible Chat Completions gateway** backed by the official [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript). Expose Cursor models to standard OpenAI clients, issue per-client API keys, and review traffic in a built-in admin UI.

**中文文档：** [`README.zh-CN.md`](./README.zh-CN.md)

**Version:** [`VERSION`](./VERSION) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

---

## Quick start (Docker Compose)

Fastest path from zero to a working endpoint on `http://127.0.0.1:8787`.

### 1. Prerequisites

- Docker with Compose
- A **Cursor User API Key** ([Cursor dashboard](https://cursor.com/settings))
- Node **22.13+** only if you run from source (see [Local development](#local-development))

### 2. Configure secrets

All settings live in one file: `data/config/gateway.toml` (**not in git**).

```bash
cp data/config/gateway.toml.example data/config/gateway.toml
chmod 600 data/config/gateway.toml
```

Edit `data/config/gateway.toml`:

```toml
host = "0.0.0.0"
port = 8787

cursor_api_key = "your-cursor-user-api-key"
admin_access_key = "pick-a-long-random-admin-secret"
api_key_pepper = "pick-another-long-random-string"
```

| Key | Purpose |
|-----|---------|
| `cursor_api_key` | Upstream Cursor credential (single account) |
| `admin_access_key` | Unlocks `/admin/` and `/admin/api/*` |
| `api_key_pepper` | HMAC salt for stored client key digests |
| `host`, `port` | Listen address (optional; see defaults below) |

> **Do not commit** `gateway.toml`. Template: `data/config/gateway.toml.example`.  
> **Docker:** if `gateway.toml` is missing on first start, the container creates an empty file under the mounted `data/` volume — fill secrets and restart.

### 3. Start the gateway

```bash
# Stop anything else bound to 8787 first.
docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
docker compose up -d
curl -s http://127.0.0.1:8787/health
```

Expected: JSON with `status`, `version`, `git_commit`, `schema_version`.

**Linux bind-mount:** if the container cannot read `gateway.toml` (`chmod 600`), match the file owner:

```bash
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

Optional overrides: [`.env.example`](./.env.example).

### 4. Client key & connect

1. Open **http://127.0.0.1:8787/admin/** → enter `admin_access_key`.
2. **Client Keys** → create a key (`cgk_…`). Copy once; only a hash is stored.
3. Point any OpenAI-compatible client at:

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<your cgk_ client key>
```

**Smoke test:**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cgk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Reply with PONG only."}]}'
```

Browsers on `/` → `/admin/`; `curl /` → JSON discovery.

---

## Client integration

### Authentication

Either header works:

```http
Authorization: Bearer cgk_...
X-Api-Key: cgk_...
```

### Supported OpenAI surface

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/v1/chat/completions` | Client key |
| `GET` | `/v1/models` | Client key |
| `GET` | `/v1/models/{id}` | Client key |
| `OPTIONS` | `/v1/*` | CORS preflight |

**Request body (essentials)**

- **Required:** `model`, non-empty `messages`
- **Streaming:** `stream: true` (boolean only)
- **Vision:** `image_url` with `data:` or `http(s):` URLs
- **Forwarded to Cursor:** `params`, `variant`, `reasoning_effort`, `verbosity`, `fast`, `optimize_for`
- **Accepted but ignored:** `temperature`, `top_p`, …
- **Not supported:** tools / function calling, audio, `n > 1`, non-text `response_format`

Responses may include `cursor.cost` and usage from the SDK.

### Example: OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="cgk_YOUR_KEY",
)

print(client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

### Example: environment variables

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=cgk_YOUR_KEY
```

---

## Admin UI

Single-page console: `/admin/` (alias `/management.html`).

| Area | Description |
|------|-------------|
| **Overview** | Gateway status, base URL hint, recent activity |
| **Client Keys** | Create, enable/disable client keys |
| **Request logs** | Filter by time range, status, model; paginated history |

Admin REST API: `/admin/api/*`

```http
Authorization: Bearer <admin_access_key>
X-Management-Key: <admin_access_key>
```

`GET /v1/usage` and `x-ratelimit-*` headers, when present, reflect **gateway client-key quotas**, not Cursor account balance.

---

## Configuration

**Priority (highest wins):** environment variables → `.env` → `data/config/gateway.toml` → defaults

| File | Contents |
|------|----------|
| `data/config/gateway.toml` | Secrets + `host`, `port`, optional `data_dir`, `cursor_workspace` |

**Listen defaults**

| Context | Address | Port |
|---------|---------|------|
| `npm run dev` | `127.0.0.1` | `8787` |
| Docker (`NODE_ENV=production`) | `0.0.0.0` | `8787` |

SQLite and workspace live under `data/` (Compose volume). Do not bake secrets into the image or Compose `environment` for routine deploys.

See [`.env.example`](./.env.example) for optional env keys.

---

## Local development

```bash
npm ci
cp data/config/gateway.toml.example data/config/gateway.toml
chmod 600 data/config/gateway.toml
npm run dev          # node --experimental-strip-types
npm run build && npm start
npm test
npm run typecheck
```

| Check | Path |
|-------|------|
| Health | `GET /health` |
| Discovery | `GET /` (JSON) or browser → `/admin/` |

---

## Operations

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness, `version`, `git_commit`, `schema_version` |
| `GET /` | JSON API map |

**Docker:** multi-stage, `linux/amd64`, `TZ=UTC`. Tag with [`VERSION`](./VERSION). Pass `GIT_COMMIT` at build time.

**Upgrade:** read [`CHANGELOG.md`](./CHANGELOG.md), back up `data/` if needed, rebuild, confirm `/health`.

---

## Architecture

```text
OpenAI client  --Bearer cgk_*-->  cursor-api  --Cursor SDK-->  Cursor Cloud
                                      |
                                      +-- SQLite (keys, request logs)
                                      +-- Admin UI (/admin/)
```

Single upstream Cursor account. No multi-upstream routing in this MVP.

---

## License

MIT — see [`package.json`](./package.json).
