# cursor-api

**OpenAI-compatible gateway for Cursor models.** Point any OpenAI client at `/v1`; manage client keys and logs in a built-in admin UI.

![Built-in admin: overview, client keys, request logs, and OpenAI base URL for clients](./docs/images/admin-overview.png)

**Chinese:** [`README.zh-CN.md`](./README.zh-CN.md) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

**You need:** [Docker Compose](https://docs.docker.com/compose/) and a [Cursor User API Key](https://cursor.com/settings).

## Deploy in 4 steps

**No git clone.** Create a folder, save the `docker-compose.yml` below, pull `ghcr.io/xjoker/cursor-api:latest`, and go.

1. **Save `docker-compose.yml` and start** — `docker compose up -d`
2. **Config is created for you** — `data/config/gateway.toml` (empty template on first run)
3. **Edit that file** — fill in three secrets (see below)
4. **Restart** — `docker compose restart` → `http://127.0.0.1:8787`

---

## 1. `docker-compose.yml` + start

Create a directory (any path), save this as `docker-compose.yml`:

```yaml
services:
  cursor-api:
    image: ghcr.io/xjoker/cursor-api:latest
    platform: linux/amd64
    user: "${GATEWAY_UID:-1000}:${GATEWAY_GID:-1000}"
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Start:

```bash
mkdir -p cursor-api && cd cursor-api
# paste the yaml above into docker-compose.yml
docker compose up -d
```

The first start may exit until secrets are filled in — that is expected. It still creates `data/config/gateway.toml` under `./data`.

**Linux only — if the container cannot read `gateway.toml` after you edit it:** the config file is mode `600` (owner-only). The container must run as the same user ID that owns the file. Before the **first** start:

```bash
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

(`GATEWAY_UID` / `GATEWAY_GID` in compose = which Linux user the container runs as. Default is `1000`. macOS and Windows Docker usually ignore this.)

**Upgrading from an older compose** that used the service name `gateway`: remove the orphan container so port 8787 is free:

```bash
docker compose down --remove-orphans
docker compose up -d
```

---

## 2. Edit `data/config/gateway.toml`

Open the file the container created under `./data/config/gateway.toml`.

```toml
host = "0.0.0.0"
port = 8787

cursor_api_key = "your-cursor-user-api-key"
admin_access_key = "pick-a-long-random-admin-secret"
api_key_pepper = "pick-another-long-random-string"

[logs]
retention_days = 7
max_rows = 100000
detailed = false
```

| Key | What it is |
|-----|------------|
| `cursor_api_key` | Your Cursor account key (upstream) |
| `admin_access_key` | Password for `/admin/` |
| `api_key_pepper` | Random string used to hash client keys |
| `[logs].retention_days` | Drop request logs older than N days (1–3650), default **7** |
| `[logs].max_rows` | Cap SQLite request log rows; oldest deleted first (1k–10M) |
| `[logs].detailed` | Store request/response JSON for admin modal (default **false**). Stores prompts in **plaintext** under `./data` — keep the volume private |
| `[logs].detailed_max_bytes` | Per-field cap for request/response JSON (4KiB–1MiB, default 64KiB) |
| `[logs].max_detail_bytes` | Cap total UTF-8 bytes of `model` + detail columns (default 256MiB); oldest rows dropped first |

```bash
chmod 600 data/config/gateway.toml
```

---

## 3. Restart

```bash
docker compose restart
curl -s http://127.0.0.1:8787/health
```

You should see `"status":"ok"`.

---

## 4. Connect a client

1. Open **http://127.0.0.1:8787/admin/** → enter `admin_access_key`.
2. **Client Keys** → create a key (`cgk_…`). Copy it once.
3. Configure your OpenAI-compatible app:

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<your cgk_ client key>
```

**Quick test:**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cgk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Reply with PONG only."}]}'
```

---

## Client integration

**Auth:** `Authorization: Bearer cgk_...` or `X-Api-Key: cgk_...`

| Method | Path |
|--------|------|
| `POST` | `/v1/chat/completions` |
| `POST` | `/v1/responses` |
| `GET` | `/v1/models`, `/v1/models/{id}` |

Codex and OpenCode with `"npm": "@ai-sdk/openai"` call `POST /v1/responses` (`input`, `instructions`, `function_call` / `function_call_output`, typed SSE). `"npm": "@ai-sdk/openai-compatible"` still uses Chat Completions. Responses accepts and ignores sampling knobs (`temperature`, `top_p`, …); Chat Completions still 400s them. `previous_response_id` resumes the same Cursor agent.

Streaming (`stream: true`), vision (`image_url`, plus OpenCode `image` / image `file` parts), thinking (`delta.reasoning_content`), and Cursor knobs (`params`, `variant`, `reasoning_effort`, …) are supported. `variant` matches a unique catalog display name, or an effort/reasoning/fast value when Cursor repeats the same display name (OpenCode `--variant high` does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the body). OpenAI tool calling (`tools` / `tool_calls` / `role: tool`) is supported so clients like OpenCode can run tools locally. Cursor shell/file tools stay off; MCP is enabled only to surface those client tools. Audio is not. `temperature` / `top_p` / `seed` 400; `max_tokens` is accepted. `conversation_id` (or `metadata.conversation_id`) resumes the same Cursor agent for that client key. Tool parks time out after `park_timeout_ms` (default 300000); after a gateway restart, tool results continue from the HTTP transcript.

For OpenCode `-f` images and `--thinking`, set the model flags in `opencode.json`:

For OpenCode `-f` images and `--thinking`, set the model flags in `opencode.json`:

```json
"grok-4.5": {
  "name": "Cursor Grok 4.5",
  "attachment": true,
  "reasoning": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="cgk_YOUR_KEY")
print(client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

---

## Admin UI

Browser console at `/admin/`: overview (including a 7-day call chart), client keys (create / disable / enable / delete), request logs, and system logs.

Admin API: `/admin/api/*` with the same `admin_access_key` (`Authorization: Bearer` or `X-Management-Key`). `DELETE /admin/api/keys/{id}` removes a client key and keeps its request logs. `GET /admin/api/system-logs` lists gateway stdout/stderr events stored in SQLite.

---

## Configuration reference

Single file: `data/config/gateway.toml`. Optional overrides: [`.env.example`](./.env.example).

**Priority:** environment variables → `.env` → TOML → defaults.

SQLite and workspace live under `./data`. Request logs and system logs are pruned by `[logs]` limits on each write and at startup. Container stdout is rotated by compose `logging.options` (max ~30 MB).

---

## Local development

Clone this repository if you want to hack on the gateway or run tests:

```bash
git clone https://github.com/xjoker/cursor-api.git && cd cursor-api
npm ci && npm run dev
```

Requires Node **22.13+** and `data/config/gateway.toml`. See [`docker-compose.yml`](./docker-compose.yml) to build the image locally. Pass the git SHA at image build time so `/health` `git_commit` is not `unknown`:

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose build
```

---

## Health

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Version and liveness |
| `GET /` | JSON API map (`curl`) or redirect to admin (browser) |

---

## License

MIT — see [`package.json`](./package.json).
