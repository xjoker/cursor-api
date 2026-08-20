# cursor-api

**OpenAI-compatible gateway for Cursor models.** Point any OpenAI client at `/v1`; manage client keys and logs in a built-in admin UI.

**中文文档：** [`README.zh-CN.md`](./README.zh-CN.md) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

**You need:** [Docker Compose](https://docs.docker.com/compose/) and a [Cursor User API Key](https://cursor.com/settings).

## Deploy in 4 steps

1. **Start the container** — `docker compose up -d`
2. **Config is created for you** — `data/config/gateway.toml` (empty template on first run)
3. **Edit that file** — fill in three secrets (see below)
4. **Restart** — `docker compose restart` → gateway listens on `http://127.0.0.1:8787`

No manual copy of example files. No secrets in the image or in git.

---

## 1. Start the container

```bash
cd cursor-api   # clone this repository first
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)   # Linux: set before the first start
docker compose up -d
```

The first start may exit until secrets are filled in — that is expected. It still creates `data/config/gateway.toml` under the mounted `data/` folder.

**Linux:** run the `GATEWAY_UID` / `GATEWAY_GID` lines **before** the first `docker compose up -d`, so the auto-created config file is owned by your user. If you already started once as UID 1000, fix ownership then restart:

```bash
sudo chown "$(id -u):$(id -g)" data/config/gateway.toml
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

---

## 2. Edit `data/config/gateway.toml`

Open the file the container created (or create it from [`gateway.toml.example`](./data/config/gateway.toml.example) if you run from source).

```toml
host = "0.0.0.0"
port = 8787

cursor_api_key = "your-cursor-user-api-key"
admin_access_key = "pick-a-long-random-admin-secret"
api_key_pepper = "pick-another-long-random-string"
```

| Key | What it is |
|-----|------------|
| `cursor_api_key` | Your Cursor account key (upstream) |
| `admin_access_key` | Password for `/admin/` |
| `api_key_pepper` | Random string used to hash client keys |

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
| `GET` | `/v1/models`, `/v1/models/{id}` |

Streaming (`stream: true`), vision (`image_url`), and Cursor knobs (`params`, `variant`, `reasoning_effort`, …) are supported. Tool calling and audio are not.

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

Browser console at `/admin/`: overview, client keys, request logs (time filters, pagination).

Admin API: `/admin/api/*` with the same `admin_access_key` (`Authorization: Bearer` or `X-Management-Key`).

---

## Configuration reference

Single file: `data/config/gateway.toml`. Optional overrides: [`.env.example`](./.env.example).

**Priority:** environment variables → `.env` → TOML → defaults.

All runtime data (SQLite, workspace) lives in `./data` and persists across restarts.

---

## Local development

Requires Node **22.13+**. Copy and fill `data/config/gateway.toml`, then:

```bash
npm ci && npm run dev
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
