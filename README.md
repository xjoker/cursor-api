# cursor-api

**OpenAI-compatible gateway for Cursor models.** Point any OpenAI client at `/v1`; manage client keys and logs in a built-in admin UI.

**Chinese:** [`README.zh-CN.md`](./README.zh-CN.md) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

**You need:** [Docker Compose](https://docs.docker.com/compose/) and a [Cursor User API Key](https://cursor.com/settings).

> **⚠️ BREAKING (next release): the default listen address is now `127.0.0.1`.** Without `host` or `GATEWAY_HOST`, the gateway accepts connections from this machine only. **Affected:** anyone who reaches the gateway from another machine without Docker (PM2 / systemd / `NODE_ENV=production npm start`), and custom container images that do not use this repo's `Dockerfile`. The official image and compose files still listen on `0.0.0.0` inside the container. To listen on all interfaces again, set `host = "0.0.0.0"` or `GATEWAY_HOST=0.0.0.0`. **Risk:** this exposes the gateway, and with it your Cursor account, to every network the host can reach. Only do it behind a firewall or reverse proxy. See [Upgrading: listen address](#upgrading-listen-address).

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
mkdir -p data
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
# host = "0.0.0.0"  # unset = image default 0.0.0.0; a value here wins (GATEWAY_HOST env wins over both)
port = 8787

cursor_api_key = "your-cursor-user-api-key"
admin_access_key = "pick-a-long-random-admin-secret"
api_key_pepper = "pick-another-long-random-string"
# park_timeout_ms = 300000

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
| `park_timeout_ms` | How long a pending tool round stays in memory (default **300000**). After a restart, the next tool-result request continues from the HTTP transcript |

```bash
chmod 600 data/config/gateway.toml
```

---

## 3. Restart

```bash
docker compose restart
curl -s http://127.0.0.1:8787/health
```

You should see `"status":"ok"`. After pulling a new image, compare `version` and `git_commit` with the tag you expect — a successful registry push does not update a running container:

```bash
docker compose pull && docker compose up -d
curl -s http://127.0.0.1:8787/health
# {"status":"ok","version":"20260828.10","git_commit":"<sha>","schema_version":6}
```

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

| Method | Path | Typical clients |
|--------|------|-----------------|
| `POST` | `/v1/chat/completions` | OpenAI SDK, OpenCode `"npm": "@ai-sdk/openai-compatible"` |
| `POST` | `/v1/responses` | Codex, OpenCode `"npm": "@ai-sdk/openai"` |
| `GET` | `/v1/models`, `/v1/models/{id}` | Model list |

Streaming (`stream: true`), vision (`image_url`, plus OpenCode `image` / image `file` parts), thinking (`delta.reasoning_content`), and Cursor knobs (`params`, `variant`, `reasoning_effort`, …) are supported. `variant` matches a unique catalog display name, or an effort/reasoning/fast value when Cursor repeats the same display name (OpenCode `--variant high` does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the body). OpenAI tool calling (`tools` / `tool_calls` / `role: tool`) is supported so clients like OpenCode can run tools locally. Cursor shell/file tools stay off; MCP is enabled only to surface those client tools. Audio is not. `temperature` / `top_p` / `seed` 400; `max_tokens` is accepted. `conversation_id` (or `metadata.conversation_id`) resumes the same Cursor agent for that client key; IDs are limited to 512 UTF-8 bytes and the newest 1,000 mappings per client key are retained. Tool parks time out after `park_timeout_ms` (default 300000); after a gateway restart, tool results continue from the HTTP transcript.

The Cursor SDK accepts each turn as one prompt rather than native OpenAI role messages. This gateway serializes `system` / `developer` / `user` roles into transcript text, so application-supplied `system` or `developer` messages are context, not a hard security boundary against hostile user content.

### Codex (`POST /v1/responses`)

Point Codex at this gateway's `/v1`. Compaction (`/compact`) works: Responses accepts `parallel_tool_calls: false` and `tools: []` (the flag is ignored; Cursor does not distinguish it). Chat Completions still 400s `parallel_tool_calls: false`.

Also accepted on Responses and ignored: sampling knobs (`temperature`, `top_p`, …) and unknown top-level fields (`client_metadata`, `include`, …). Codex `custom` tools (`apply_patch`) round-trip as `custom_tool_call` with freeform `input`. Nested `namespace` tools flatten to functions. Unnamed hosted tools (`web_search`, …) are dropped. Replayed assistant text next to `function_call` items is merged so the following tool-result round stays valid. `previous_response_id` resumes the same Cursor agent.

### OpenCode

`"npm": "@ai-sdk/openai"` uses Responses. `"npm": "@ai-sdk/openai-compatible"` uses Chat Completions. For `-f` images and `--thinking`, set the model flags in `opencode.json`:

```json
"grok-4.5": {
  "name": "Cursor Grok 4.5",
  "attachment": true,
  "reasoning": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

`variant` matches a unique catalog display name, or an effort/reasoning/fast value when Cursor repeats the same display name. OpenCode `--variant high` does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the body.

### Chat Completions

Streaming (`stream: true`), vision (`image_url`, plus OpenCode `image` / image `file` parts), thinking (`delta.reasoning_content`), Cursor knobs (`params`, `variant`, `reasoning_effort`, …), and OpenAI tool calling (`tools` / `tool_calls` / `role: tool`) are supported so local clients can run tools. Cursor shell/file tools stay off; MCP is enabled only to surface those client tools.

Audio is not supported. `temperature` / `top_p` / `seed` 400; `max_tokens` is accepted. `conversation_id` (or `metadata.conversation_id`) resumes the same Cursor agent for that client key. Tool parks time out after `park_timeout_ms` (default 300000); after a gateway restart, tool results continue from the HTTP transcript.

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

**Listen address** (highest priority first):

1. `GATEWAY_HOST` environment variable (`docker run -e`, compose `environment:`, PM2 `env`, systemd `Environment=`, `.env`)
2. `host` in `gateway.toml`
3. `GATEWAY_DEFAULT_HOST` — set to `0.0.0.0` by the Docker image so published ports work out of the box; not meant to be set by hand
4. `127.0.0.1` (this machine only)

So in Docker the container listens on `0.0.0.0` unless your `gateway.toml` says otherwise, and outside Docker it listens on `127.0.0.1`. If `GATEWAY_HOST` overrides a different `host` from `gateway.toml`, the gateway logs a `warn` line at startup. Keep the host side of port mappings on loopback (`127.0.0.1:8787:8787`); do not drop the `127.0.0.1:` prefix unless you mean to expose the gateway.

SQLite and workspace live under `./data`. Request logs and system logs are pruned by `[logs]` limits on each write and at startup. Container stdout is rotated by compose `logging.options` (max ~30 MB).

---

## Upgrading: listen address

**BREAKING — non-Docker deployments now listen on `127.0.0.1` by default.**

- **What changed:** with no `host` in `gateway.toml` and no `GATEWAY_HOST`, the gateway now listens on `127.0.0.1`. Older releases listened on `0.0.0.0` when `NODE_ENV=production`.
- **Affected (remote access stops working):**
  - running without Docker under `NODE_ENV=production` (PM2, systemd, …) and reaching the gateway from other machines, when `gateway.toml` has no `host` and `GATEWAY_HOST` is not set;
  - custom container images or entrypoints that run `node dist/index.js` without this repo's `Dockerfile` (they do not get `GATEWAY_DEFAULT_HOST=0.0.0.0`), so published ports stop answering.
- **Symptom:** after upgrading, `curl http://127.0.0.1:8787/health` works on the server, but other machines get *connection refused*.
- **Check:** `ss -ltnp | grep 8787` — `127.0.0.1:8787` means you are affected.
- **Restore listening on all interfaces**, then restart:
  - `gateway.toml`: add `host = "0.0.0.0"`, or
  - PM2: `env: { GATEWAY_HOST: "0.0.0.0" }` in the ecosystem file, then `pm2 restart <app> --update-env`, or
  - systemd: `Environment=GATEWAY_HOST=0.0.0.0` in the unit (or a drop-in), then `systemctl daemon-reload && systemctl restart <unit>`.
  - custom image: `ENV GATEWAY_DEFAULT_HOST=0.0.0.0` (keeps `gateway.toml` `host` in charge) or `-e GATEWAY_HOST=0.0.0.0`.
- **Risk:** `0.0.0.0` exposes the gateway, and with it your Cursor account, to every network the host is on. Put it behind a firewall or reverse proxy, use strong `admin_access_key` and client keys, and keep Docker port mappings on `127.0.0.1:` unless you mean to publish. Docker's `-p` rules bypass ufw.
- **Not affected:** the official image and the repo's compose files (the container still listens on `0.0.0.0`; the host-side port stays `127.0.0.1:8787`), and configs that already contain `host = "0.0.0.0"` (including ones auto-created by older releases).
- **Docker note:** the image now sets `GATEWAY_DEFAULT_HOST=0.0.0.0` instead of `GATEWAY_HOST`, so a `host` written in a mounted `gateway.toml` takes effect inside the container.

---

## Local development

Clone this repository if you want to hack on the gateway or run tests:

```bash
git clone https://github.com/xjoker/cursor-api.git && cd cursor-api
npm ci && npm run dev
```

Use `npm run test:unit` for the fast unit suite. `npm test` also runs the loopback HTTP authentication smoke test.

Requires Node **22.13+** and `data/config/gateway.toml`. See [`docker-compose.yml`](./docker-compose.yml) to build the image locally. Pass the git SHA at image build time so `/health` `git_commit` is not `unknown`:

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose build
```

---

## Health

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness: `status`, `version`, `git_commit`, `schema_version` |
| `GET /` | JSON API map (`curl`) or redirect to admin (browser) |

`version` comes from [`VERSION`](./VERSION). After a GHCR tag, pull/restart the container and compare `/health` before assuming the new build is running.

---

## License

MIT — see [`package.json`](./package.json).
