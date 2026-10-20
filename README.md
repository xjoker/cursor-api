# cursor-api

English | [简体中文](README.zh-CN.md)

**OpenAI-compatible gateway for Cursor models.** Point a client that uses the OpenAI request format at `/v1`; manage client keys and logs in a built-in admin UI. Unit tests cover the standard OpenAI request format and the request shapes Codex and OpenCode send; that is not end-to-end testing with those clients. Compatibility is partial: audio is not supported, and Chat Completions returns 400 by default for `temperature` / `top_p` / `seed`. See [Client integration](#client-integration).

> **Unofficial.** `cursor-api` is not affiliated with or endorsed by Cursor (Anysphere, Inc.) or OpenAI. Their names are used only to describe compatibility.
>
> **Terms of Service risk:** using this gateway may violate Cursor's [Terms of Service](https://cursor.com/terms-of-service) or [Acceptable Use Policy](https://cursor.com/acceptable-use-policy), which can lead to suspension or termination of your Cursor account. You use it at your own risk.
>
> **Usage:** use only your own Cursor API key (the upstream `cursor_api_key`, not the `cgk_` client keys the gateway issues), for local personal use. Do not share your Cursor API key among multiple people or host the gateway as a public service. Follow Cursor's terms when using it.

**Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

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
| `cursor_api_keys` | Optional extra Cursor keys, comma-separated (env `CURSOR_API_KEYS`). Together with `cursor_api_key` they form a pool: new agents rotate round-robin across healthy keys, and a key that returns an upstream auth or rate-limit error is cooled down while the request fails over to the next key. Failover stops once any output has been streamed to the client. Pending tool rounds continue on the agent (and key) that started them |
| `cursor_key_cooldown_ms` | Cooldown after a rate limit (default **60000**, 1s–24h). Repeated failures double it, up to x8. Auth failures cool down for 15 minutes |
| `cursor_key_strategy` | `round_robin` (default) rotates keys evenly. `least_active` sends each request to the healthy key with the fewest in-flight requests, with ties rotating. `GET /admin/api/cursor-keys` reports `active_requests`, `successes`, `failures` and `last_used_at` per key |
| `park_timeout_ms` | How long a pending tool round stays in memory (default **300000**). After a restart, the next tool-result request continues from the HTTP transcript |
| `max_live_sessions` | Maximum running and parked Cursor sessions in memory (default **256**); a pending creation counts toward the limit |
| `conversation_ttl_days` | Drop unused persisted `conversation_id` mappings after this many days (default **30**) |
| `ignore_sampling_params` | Drop unsupported Chat Completions sampling knobs (`temperature`, `top_p`, `top_k`, penalties, `seed`, OpenRouter `min_p` / `top_a` / `repetition_penalty`, `parallel_tool_calls: false`) instead of returning 400 (default **false**). Output-shaping fields (`stop`, `logit_bias`, `top_logprobs`) still 400 |
| `history_resume` | Without a client `conversation_id` (Chat Completions, Messages, Responses without `previous_response_id`), resume the previous Cursor agent when the request's history before the last user message matches a finished turn, and send only the new user message (env `HISTORY_RESUME`, default **true**). The match is a hash of every message (assistant text trimmed), single-use (a regenerated or branched turn gets a fresh agent with the full transcript), per client key, kept in memory for 1 h (newest 10,000). Truncated (`length` / stop-sequence) and JSON-mode replies are not remembered. A failed resume falls back to the full transcript before anything is streamed. `false` = previous behaviour (full transcript to a new agent every turn) |
| `enforce_output_limits` | Enforce `max_tokens` / `max_completion_tokens` (Chat), `max_output_tokens` (Responses), `max_tokens` (Messages) and `stop` / `stop_sequences` **at the gateway** (env `ENFORCE_OUTPUT_LIMITS`, default **false** = unchanged: token limits accepted and ignored, `stop` / non-empty `stop_sequences` 400). `true`: the visible text is cut and the Cursor run cancelled; finish reason `length` (Responses `status: "incomplete"`, Messages `stop_reason: "max_tokens"`) or `stop` (Messages `stop_reason: "stop_sequence"` with `stop_sequence`). Tokens are **estimated** at 4 characters each; thinking text is not counted; up to 4 stop sequences on Chat. A stop sequence never reaches a streaming client (a few trailing characters are held back until they cannot start one). Usage still reports what Cursor billed |
| `allow_max_mode` | Allow Cursor **max mode** (env `ALLOW_MAX_MODE`, default **true**). The pinned `@cursor/sdk` turns max mode on by itself whenever every catalog variant matching the resolved params is max-only, and max mode is billed at higher rates. The gateway starts from the model's default variant, so a bare model name whose default variant is max-only (e.g. a long-context default) runs in max mode. `false`: the gateway swaps in the closest non-max variant that keeps the client's explicit choices, and rejects requests that only a max variant can serve (max-only models, `variant`/`params`/`reasoning_effort` naming a max variant) with `403 max_mode_not_allowed`. Soft effort hints (Anthropic `output_config.effort` / `thinking.budget_tokens`, Responses `reasoning.effort`) are dropped instead and the drop is logged (`max mode disallowed: using non-max variant`, `softened_hint`). A param value that only max variants carry (e.g. `context=1m`) is never forwarded, even mixed with other choices. After `Agent.create` / `resume` / `send` the gateway also checks the model the SDK actually resolved (`agent.model` / `run.model`, which can differ from the gateway catalog); if it is max mode the agent is released or the run cancelled and the request gets `403` (streaming: an SSE error frame, and no model text is streamed before that check). Every request log row records the **actual** `max_mode` |
| `quota_cache_read_weight` | Weight (0–1, env `QUOTA_CACHE_READ_WEIGHT`, default **1.0**) of cache-read tokens in per-key `quota_tokens`; a key's own `quota_cache_read_weight` overrides it |
| `sse_keepalive_ms` | Interval for SSE `: keepalive` comments during idle streams (default **15000**; `0` disables) |
| `cors_allow_origins` | Browser origins, default `"*"`. Use comma-separated exact HTTP(S) origins or an empty string to disable CORS. `CORS_ALLOW_ORIGINS` overrides TOML, including an explicitly empty value |
| `auth_failure_limit` | Failed authentications allowed per client address in any 60-second sliding window (default **20**, max 1000; `0` turns it off). Admin and client keys are counted separately. **Admin:** once the limit is reached, every admin request from that address gets `429` with `Retry-After` until the window clears, even with the correct key. **Client keys:** a valid key is never throttled; only further wrong keys get `429` + `Retry-After` instead of `401`. Requests without any key are not counted. IPv6 addresses are grouped per /64 |
| `trusted_proxies` | Comma-separated IPs or CIDRs of your reverse proxies, e.g. `"127.0.0.1, 172.18.0.0/16"` (env `TRUSTED_PROXIES`). Default empty: the TCP peer address is the client address and `X-Forwarded-For` is ignored. When the peer is listed, the client address is the right-most `X-Forwarded-For` entry that is not a listed proxy. Behind a proxy without this setting, all clients share the proxy's address for `auth_failure_limit`. Only list proxies that overwrite or append `X-Forwarded-For` (nginx `proxy_add_x_forwarded_for`, Caddy default) |

Existing conversations stay bound to the Cursor key that created them, including after a restart. SQLite stores only its fingerprint. Removing that key causes an incremental continuation to fail explicitly; resend the full history to replay it. Legacy mappings without an owner require full history when multiple keys are configured.

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

**Auth:** `Authorization: Bearer cgk_...` or `X-Api-Key: cgk_...` (Anthropic clients send `x-api-key`)

| Method | Path | Typical clients |
|--------|------|-----------------|
| `POST` | `/v1/chat/completions` | OpenAI SDK, OpenCode `"npm": "@ai-sdk/openai-compatible"` |
| `POST` | `/v1/responses` | Codex, OpenCode `"npm": "@ai-sdk/openai"` |
| `POST` | `/v1/messages` | Anthropic SDK, Claude-compatible clients |
| `GET` | `/v1/models`, `/v1/models/{id}` | Model list |
| `GET` | `/v1/responses/{id}` | Retrieve a finished Response (in memory, per client key, 1 h, newest 1,000; not with `store: false`; lost on restart) |

Streaming (`stream: true`), vision (`image_url`, plus OpenCode `image` / image `file` parts), thinking (`delta.reasoning_content`, duplicated as `delta.reasoning` / `message.reasoning` for OpenRouter-style clients), and Cursor knobs (`params`, `variant`, `reasoning_effort`, …) are supported. `variant` matches a unique catalog display name, or an effort/reasoning/fast value when Cursor repeats the same display name (OpenCode `--variant high` does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the body). OpenAI tool calling (`tools` / `tool_calls` / `role: tool`) is supported so clients like OpenCode can run tools locally. Cursor shell/file tools stay off; MCP is enabled only to surface those client tools. Audio is not. `temperature` / `top_p` / `seed` 400; `max_tokens` is accepted. `reasoning_effort` is best-effort: exact model value, else the nearest level, ignored for models without an effort control (boolean thinking toggles map `none`/`minimal` to off).

OpenRouter-style `reasoning: { effort, max_tokens, enabled, exclude }` is accepted on Chat Completions as a soft hint (never a 400): `effort` maps to the nearest level, `max_tokens` picks a level by budget (<4096 low, <16384 medium, else high), `enabled: false` asks for the lowest level, and `exclude: true` omits thinking text from the reply. A top-level `reasoning_effort` wins over it. `response_format` `json_object` / `json_schema` (and Responses `text.format`) are **best-effort**: Cursor has no constrained decoding, so the gateway appends a JSON instruction (with the schema) to the prompt it sends upstream and, for non-streaming replies, strips a surrounding ```` ```json ```` fence; a reply that still is not valid JSON is returned unchanged and logged (`json output requested but the reply is not valid JSON`). The schema is not validated. See `enforce_output_limits` for `max_tokens` / `stop`.

Usage follows OpenAI semantics: `prompt_tokens` includes cached tokens (`prompt_tokens_details.cached_tokens` = cache reads; cache writes are also returned as `cache_write_tokens`), `completion_tokens_details.reasoning_tokens` appears when the model reports it, and `total_tokens = prompt_tokens + completion_tokens`. Request logs store `input_tokens` the same way (rows written before this change hold uncached input). `conversation_id` (or `metadata.conversation_id`) resumes the same Cursor agent for that client key; IDs are limited to 512 UTF-8 bytes and the newest 1,000 mappings per client key are retained. Tool parks time out after `park_timeout_ms` (default 300000); after a gateway restart, tool results continue from the HTTP transcript.

The Cursor SDK accepts each turn as one prompt rather than native OpenAI role messages. This gateway serializes `system` / `developer` / `user` roles into transcript text, so application-supplied `system` or `developer` messages are context, not a hard security boundary against hostile user content.

### Anthropic Messages (`POST /v1/messages`)

Point Anthropic SDKs and Claude-compatible tools at the gateway root (the SDK appends `/v1/messages` itself):

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<your cgk_ client key>      # sent as x-api-key
```

- `system` (string or text blocks), `text` / `image` (base64 or URL) blocks, `stream: true` (`message_start` → `content_block_*` → `message_delta` → `message_stop`), and thinking output as `thinking` blocks.
- Client tools: `tools[].input_schema` → `tool_use` blocks with `stop_reason: "tool_use"`; send `tool_result` blocks back in the next user turn (`is_error: true` is passed to the model as an error result). Extra text next to `tool_result` is appended to the last result. Server tools without `input_schema` (`web_search_…`, `bash_…`) are dropped.
- `tool_choice`: `auto`, `tool`, `none`; `any` degrades to `auto` because Cursor cannot force a call.
- Ignored: `temperature`, `top_p`, `top_k`, `thinking`, `output_config`, `context_management`, `service_tier`. Unknown top-level fields are ignored. Rejected: non-empty `stop_sequences` (accepted and enforced with `enforce_output_limits`), `document` blocks.
- Cursor knobs (`params`, `variant`, `reasoning_effort`, `verbosity`, `fast`, `optimize_for`) and `conversation_id` / `metadata.conversation_id` work as on Chat Completions.
- Errors use the Anthropic shape: `{"type":"error","error":{"type":"invalid_request_error","message":"…"}}`.
- `usage.input_tokens` (uncached, Anthropic semantics) / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` come from Cursor token usage; `cursor.cost` is included on non-stream responses.
- `POST /v1/messages/count_tokens` is disabled by default; an optional rough estimate is available (see Claude Code below).

### Claude Code

Claude Code CLI 2.x works against `/v1/messages` (verified with `claude -p`, including a Bash tool round, `/context`, and streaming):

```bash
# gateway.toml (or env MODEL_ALIASES): map Claude model names onto Cursor models
#   model_aliases = "claude-haiku-*=composer-2.5, claude-*=composer-2.5"
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=cgk_YOUR_KEY          # sent as x-api-key
claude -p "Reply with PONG"
```

What the gateway does with Claude Code traffic:

- `POST /v1/messages?beta=true` with `anthropic-beta` flags: every beta flag and unknown top-level field (`context_management`, `safeguards`, `output_config`, …) is accepted and ignored.
- Claude model ids (`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*` for background tasks) go through `model_aliases`. First match wins, `*` is a wildcard, and it applies to every endpoint. Without a match the id goes to the Cursor catalog unchanged and fails with `not_found_error`.
- `system` messages inside `messages` are folded into the preceding user / tool turn as `[system]` context, so tool rounds keep matching the parked Cursor session instead of replaying the transcript.
- `thinking` / `output_config.effort` become a best-effort reasoning level (effort `low`–`max`; `budget_tokens` <4k → low, <16k → medium, otherwise high; `disabled` → lowest). Models without an effort parameter ignore it.
- Server tool blocks (`server_tool_use`, `web_search_tool_result`, …) in history are skipped, and `cache_control` is ignored.
- `POST /v1/messages/count_tokens` returns **404 by default** because the SDK has no exact tokenizer. Set `anthropic_count_tokens = "estimate"` (env `ANTHROPIC_COUNT_TOKENS`) to enable a rough local estimate (`x-token-count-estimated: true`; ~4 ASCII chars or 1 non-ASCII char per token). This can mislead client context compaction decisions; it is not exact token usage.
- `HEAD /api/hello` (a Claude Code connectivity probe) gets 404, which Claude Code tolerates.

### Codex (`POST /v1/responses`)

Point Codex at this gateway's `/v1`. Compaction (`/compact`) requests are accepted: Responses accepts `parallel_tool_calls: false` and `tools: []` (the flag is ignored; Cursor does not distinguish it). Chat Completions still 400s `parallel_tool_calls: false`.

Also accepted on Responses and ignored: sampling knobs (`temperature`, `top_p`, …) and unknown top-level fields (`client_metadata`, `include`, …). Codex `custom` tools (`apply_patch`) round-trip as `custom_tool_call` with freeform `input`. Nested `namespace` tools flatten to functions. Unnamed hosted tools (`web_search`, …) are dropped. Replayed assistant text next to `function_call` items is merged so the following tool-result round stays valid. `previous_response_id` resumes the same Cursor agent. `reasoning.effort` is best-effort: it maps to the model's effort parameter when the model has one (exact value, else the nearest level, e.g. `xhigh` → `high`, `minimal` → `low`) and is ignored for models without one, so Codex defaults never 400. A top-level `reasoning_effort` (Responses and Chat Completions) follows the same rule; only a value that is neither one of the model's values nor a standard level (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) returns 400. A value the model lists is an explicit choice, so `allow_max_mode` rules apply to it.

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

Max mode: `GET /v1/models` marks max-only variants with `is_max_mode: true`. To stay off max mode for a model whose default variant is max-only, pick a non-max variant explicitly (for example `params: [{"id":"context","value":"256k"}]`) or set `allow_max_mode = false`. If a request fails over to another Cursor key or replays a conversation, the new attempt resolves the model again; with max mode allowed, each attempt that reaches a run is billed at max rates.

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

Browser console at `/admin/`: overview (including a 7-day call chart), client keys (create / disable / enable / delete / policy & quota), request logs, and system logs.

Admin API: `/admin/api/*` with the same `admin_access_key` (`Authorization: Bearer` or `X-Management-Key`). `DELETE /admin/api/keys/{id}` removes a client key and keeps its request logs. `GET /admin/api/system-logs` lists gateway stdout/stderr events stored in SQLite. `GET /admin/api/cursor-keys` shows the upstream key pool (sha256 fingerprint, `healthy` / `cooling_down`, failure counters; keys are never returned). The overview includes `cursor_keys: {total, healthy}`.

### Per-key model policy and quotas

Each client key can carry its own policy. Every field is optional; existing keys (and new keys created without these fields) stay unrestricted, so upgrading changes nothing until you set one.

| Field | Meaning |
| --- | --- |
| `allowed_models` | `null` = any model. Otherwise a list of exact model ids or `*` wildcards (case-insensitive), e.g. `["gemini-*", "composer-2.5"]`. Checked after `model_aliases` and again on the catalog id the model resolves to, so an alias cannot unlock a model the list does not allow. Wildcards match catalog ids only; a catalog alias must be listed exactly. `GET /v1/models` only lists allowed models and `GET /v1/models/{id}` returns 404 for the rest. A disallowed model returns `403 model_not_allowed` (`param: "model"`). |
| `allow_max_mode` | `null` = inherit the gateway `allow_max_mode`. `true` / `false` overrides it for this key in either direction, with the same fallback / `403 max_mode_not_allowed` behaviour, including the check of the SDK-resolved model. |
| `quota_requests` | Maximum requests per period. Pre-charged atomically before the upstream run (concurrent requests cannot overspend) and refunded if the run never starts. |
| `quota_tokens` | Token budget per period, a **soft cap**: a request is admitted while used tokens are below the limit; its tokens are added after it finishes, so the last request can go over. |
| `quota_period` | `total` (default, never resets), `daily` or `monthly`. |
| `quota_tz` | IANA time zone for period boundaries (default `UTC`), e.g. `Asia/Singapore`. |
| `max_concurrent` | Maximum in-flight requests for the key (per gateway process). |
| `quota_cache_read_weight` | `null` = gateway `quota_cache_read_weight` (env `QUOTA_CACHE_READ_WEIGHT`, default `1.0`). A number from 0 to 1: how much each cache-read token counts toward `quota_tokens` (e.g. `0.1` ≈ cache-read pricing). |

Over quota: `429 insufficient_quota` with `Retry-After` (seconds until the period resets; omitted for `total`). Over the concurrency cap: `429 concurrency_limit_exceeded` with `Retry-After: 1`. Model checks run first, so a disallowed model gets 403/404, not 429, and is not charged.

Admin API: `POST /admin/api/keys` accepts the fields above; `PATCH /admin/api/keys/{id}` updates any of them (plus `name`; omitted fields are unchanged, `null` clears a limit); `GET /admin/api/keys/{id}/usage` returns the current period (`requests`, `tokens`, `remaining_*`, `in_flight`, `resets_at`) and recent periods; `POST /admin/api/keys/{id}/usage/reset` zeroes the current period. `GET /admin/api/keys` includes each key's policy and `usage_current`. The admin UI edits these under **Client keys → Policy**.

Token accounting limits:
- Tokens come from the SDK's per-run usage (`run.wait().usage`). Cumulative agent totals are never charged, because they would double count continued conversations. The source is pluggable for a future per-run usage API.
- Turns that end in client tool calls (parked runs) may report no usage at the point the response is sent; those turns count against `quota_requests` but may add fewer tokens than were actually used.
- Cost (USD) quotas are not available yet: local SDK agents do not expose per-request cost.

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

The image includes a Docker `HEALTHCHECK` that uses the actual bind address and port from environment variables or TOML to probe `/health`. It checks gateway liveness, not Cursor credentials or model availability.

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness: `status`, `version`, `git_commit`, `schema_version` |
| `GET /` | JSON API map (`curl`) or redirect to admin (browser) |

`version` comes from [`VERSION`](./VERSION). After a GHCR tag, pull/restart the container and compare `/health` before assuming the new build is running.

---

## License

[MIT](./LICENSE). The MIT license covers only the code in this repository. Third-party dependencies are under their own licenses; in particular, `@cursor/sdk` and its platform packages (e.g. `@cursor/sdk-linux-x64`) are proprietary (© Anysphere Inc., all rights reserved) and are included in the published Docker image.
