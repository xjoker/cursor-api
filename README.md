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
    stop_grace_period: 30s
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
| `[logs].detailed` | Store request/response JSON for admin modal (default **false**). Stores prompts in **plaintext** under `./data` — keep the volume private. Credential-looking values (`Bearer …`, `api_key=…`, `cgk_…`, fields such as `authorization`/`accessToken`) are masked before storage, as in stdout and system logs; everything else is kept verbatim |
| `[logs].detailed_max_bytes` | Per-field cap for request/response JSON (4KiB–1MiB, default 64KiB) |
| `[logs].max_detail_bytes` | Cap total UTF-8 bytes of `model` + detail columns (default 256MiB); oldest rows dropped first |
| `cursor_api_keys` | Optional extra Cursor keys, comma-separated (env `CURSOR_API_KEYS`). Together with `cursor_api_key` they form a pool: new agents rotate round-robin across healthy keys, and a key that returns an upstream auth or rate-limit error is cooled down while the request fails over to the next key. Failover stops once any output has been streamed to the client. Pending tool rounds continue on the agent (and key) that started them |
| `cursor_key_cooldown_ms` | Cooldown after a rate limit (default **60000**, 1s–24h). Repeated failures double it, up to x8. Auth failures cool down for 15 minutes |
| `cursor_key_strategy` | `round_robin` (default) rotates keys evenly. `least_active` sends each request to the healthy key with the fewest in-flight requests, with ties rotating. `GET /admin/api/cursor-keys` reports `active_requests`, `successes`, `failures` and `last_used_at` per key |
| `park_timeout_ms` | How long a pending tool round stays in memory (default **300000**). After a restart, the next tool-result request continues from the HTTP transcript |
| `request_timeout_ms` | Total deadline for each Chat/Responses request (env `REQUEST_TIMEOUT_MS`, default **300000** ms, `0` disables it), including body reading, model prechecks, and upstream generation. Expiry returns `504 request_timeout`, or ends an already-started stream with an error event. Returning tool calls ends that request's timer; the tool-result continuation gets a new deadline |
| `shutdown_timeout_ms` | Grace period for in-flight requests after SIGTERM/SIGINT (env `SHUTDOWN_TIMEOUT_MS`, default **10000** ms). New requests stop; remaining requests are cancelled and sessions cleaned up after the grace period. Compose allows 30 seconds for process shutdown |
| `max_live_sessions` | Maximum running and parked Cursor sessions in memory (default **256**); a pending creation counts toward the limit |
| `conversation_ttl_days` | Drop unused persisted `conversation_id` mappings after this many days (default **30**) |
| `quota_reserve_recent_runs` | Per-key `quota_tokens` reservations also cover the average actual usage of the key's last N runs (env `QUOTA_RESERVE_RECENT_RUNS`, default **20**, `0` = input estimate only) |
| `ignore_sampling_params` | Drop unsupported Chat Completions sampling knobs (`temperature`, `top_p`, `top_k`, penalties, `seed`, OpenRouter `min_p` / `top_a` / `repetition_penalty`, `parallel_tool_calls: false`) instead of returning 400 (default **false**). Output-shaping fields (`stop`, `logit_bias`, `top_logprobs`) still 400 |
| `history_resume` | Without a client `conversation_id` (Chat Completions, Responses without `previous_response_id`), resume the previous Cursor agent when the request's history before the last user message matches a finished turn, and send only the new user message (env `HISTORY_RESUME`, default **false**, opt-in). Why off by default: in a live test (gemini-2.5-flash) the resumed turn did not send fewer uncached input tokens than a full-transcript replay (9,527 vs 9,471); the agent's own context came back as extra cache reads (8,160), so billed tokens went up, not down. Turn it on if you prefer shorter upstream prompts or agent continuity over minimal billed tokens. The match is a hash of every message (assistant text trimmed). A record is used at most once and only while the agent's context is exactly that history: it is removed when taken, and any other use of the agent (`previous_response_id` / `conversation_id` resume, tool-result continuation, a newer turn) drops it, so a regenerated or forked turn gets a new agent with the full transcript. One request per agent at a time: a history match on a busy agent uses a new agent; a `conversation_id` / `previous_response_id` request on a busy agent gets `409 conversation_busy`. Scope: client key, plus the request's `user` field when present (clients serving several end users on one key should send it). Disabling or deleting the key drops its records. In memory for 1 h, at most 10,000 per client key (expired ones purged). A reused turn is quota-estimated like the full transcript. Truncated (`length` / stop-sequence) and JSON-mode replies are not remembered. A failed resume falls back to the full transcript before anything is streamed. `false` (default) = full transcript to a new agent every turn. **Rollback:** set `HISTORY_RESUME=false` (or run an older build) and restart; records live only in memory (no schema or data change) and are dropped when the feature is off |
| `enforce_output_limits` | Enforce `max_tokens` / `max_completion_tokens` (Chat), `max_output_tokens` (Responses) and `stop` **at the gateway** (env `ENFORCE_OUTPUT_LIMITS`, default **false** = unchanged: token limits accepted and ignored, `stop` 400). `true`: the visible text is cut and the Cursor run cancelled; finish reason `length` (Responses `status: "incomplete"`) or `stop`. Tokens are **estimated** at 4 characters each; thinking text is not counted toward the cut; up to 4 stop sequences, each at most 256 characters. Limits, streaming and JSON format apply per HTTP request (a tool-result continuation uses its own). A stop sequence never reaches a streaming client (a few trailing characters are held back until they cannot start one). Usage still reports what Cursor billed |
| `allow_max_mode` | Allow Cursor **max mode** (env `ALLOW_MAX_MODE`, default **true**). The pinned `@cursor/sdk` turns max mode on by itself whenever every catalog variant matching the resolved params is max-only, and max mode is billed at higher rates. The gateway starts from the model's default variant, so a bare model name whose default variant is max-only (e.g. a long-context default) runs in max mode. `false`: the gateway swaps in the closest non-max variant that keeps the client's explicit choices, and rejects requests that only a max variant can serve (max-only models, `variant`/`params` naming a max variant) with `403 max_mode_not_allowed`. Effort is soft on every route: Chat `reasoning_effort`, Responses `reasoning.effort` / top-level `reasoning_effort`. When the requested level needs a max variant, it degrades to the highest non-max level (else the default variant), with no 403, and this is logged (`max mode disallowed: using non-max variant`, `softened_effort`, `effort`). A param value that only max variants carry (e.g. `context=1m`) is never forwarded, even mixed with other choices. After `Agent.create` / `resume` / `send` the gateway also checks the model the SDK actually resolved (`agent.model` / `run.model`, which can differ from the gateway catalog); if it is max mode the agent is released or the run cancelled and the request gets `403` (streaming: an SSE error frame, and no model text is streamed before that check). The `send`-stage check can only run after the SDK has already dispatched the run (SDK limitation): the gateway cancels it, but the request may have reached Cursor and be billed for what it used; it is logged with `max_mode = 1` and never replayed. `params` values are matched case-insensitively (or by value display name) and always forwarded as the catalog's canonical value, so `1M` / `1m context` are treated as `1m`. Every request log row records the **actual** `max_mode` |
| `quota_cache_read_weight` | Weight (0–1, env `QUOTA_CACHE_READ_WEIGHT`, default **1.0**) of cache-read tokens in per-key `quota_tokens`; a key's own `quota_cache_read_weight` overrides it |
| `sse_keepalive_ms` | Interval for SSE `: keepalive` comments during idle streams (default **15000**; `0` disables) |
| `cors_allow_origins` | Browser origins, default `"*"`. Use comma-separated exact HTTP(S) origins or an empty string to disable CORS. `CORS_ALLOW_ORIGINS` overrides TOML, including an explicitly empty value |
| `auth_failure_limit` | Failed authentications allowed per client address in any 60-second sliding window (default **20**, max 1000; `0` turns it off). Admin and client keys are counted separately. **Admin:** once the limit is reached, every admin request from that address gets `429` with `Retry-After` until the window clears, even with the correct key. **Client keys:** a valid key is never throttled; only further wrong keys get `429` + `Retry-After` instead of `401`. Requests without any key are not counted. IPv6 addresses are grouped per /64 |
| `rate_limit_per_key` | Maximum Chat Completions and Responses generation requests per client key in a rolling 60-second window (env `RATE_LIMIT_PER_KEY`, default **0**, non-negative integer; `0` disables it). Model reads, Response retrieval, health, and admin endpoints do not consume this limit. Parsing or authentication failures, model precheck failures, and quota/concurrency admission rejections do not consume it. Once admitted, a request consumes one slot even if a later upstream or model-resolution failure occurs; streams consume one slot and each tool-result continuation is a new request |
| `trusted_proxies` | Comma-separated IPs or CIDRs of your reverse proxies, e.g. `"127.0.0.1, 172.18.0.0/16"` (env `TRUSTED_PROXIES`). Default empty: the TCP peer address is the client address and `X-Forwarded-For` is ignored. When the peer is listed, the client address is the right-most `X-Forwarded-For` entry that is not a listed proxy. Behind a proxy without this setting, all clients share the proxy's address for `auth_failure_limit`. Only list proxies that overwrite or append `X-Forwarded-For` (nginx `proxy_add_x_forwarded_for`, Caddy default) |

Existing conversations stay bound to the Cursor key that created them, including after a restart. SQLite stores only its fingerprint. Removing that key causes an incremental continuation to fail explicitly; resend the full history to replay it. Legacy mappings without an owner require full history when multiple keys are configured.

A request timeout or shutdown attempts upstream cancellation but does not establish that no charges occurred. Unsettled SDK creation or send operations still occupy capacity, and late results are cleaned up. A send with unknown dispatch status retains a conservative quota reservation. Increasing the shutdown grace period also requires increasing the container's `stop_grace_period` to leave time for cleanup.

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
| `GET` | `/v1/responses/{id}` | Retrieve a finished Response (in memory, per client key, 1 h, newest 100 / 8 MiB per key and 1,000 / 32 MiB of UTF-8 JSON payload in total. Count pressure drops the oldest entry of the key holding the most entries; byte pressure uses the key holding the most bytes. Each read/write purges expired entries globally. A response above 8 MiB is returned normally but not cached; later retrieval returns 404. Not with `store: false`; lost on restart. Payload limits do not cap process memory) |

Streaming (`stream: true`), vision (`image_url`, plus OpenCode `image` / image `file` parts), thinking (`delta.reasoning_content`, duplicated as `delta.reasoning` / `message.reasoning` for OpenRouter-style clients), and Cursor knobs (`params`, `variant`, `reasoning_effort`, …) are supported. `variant` matches a unique catalog display name, or an effort/reasoning/fast value when Cursor repeats the same display name (OpenCode `--variant high` does not send this field on `@ai-sdk/openai-compatible`; send `variant` or `reasoning_effort` on the body). OpenAI tool calling (`tools` / `tool_calls` / `role: tool`) is supported so clients like OpenCode can run tools locally. Cursor shell/file tools stay off; MCP is enabled only to surface those client tools. Audio is not. `temperature` / `top_p` / `seed` 400; `max_tokens` is accepted. `reasoning_effort` is best-effort: exact model value, else the nearest level, ignored for models without an effort control (boolean thinking toggles map `none`/`minimal` to off). The nearest-level mapping (and the thinking toggle) never picks a value that only max variants carry, even when max mode is allowed: only an exact, explicit value (e.g. `reasoning_effort: "max"` where the model lists `max`) can select max mode.

OpenRouter-style `reasoning: { effort, max_tokens, enabled, exclude }` is accepted on Chat Completions as a soft hint (never a 400): `effort` maps to the nearest level, `max_tokens` picks a level by budget (<4096 low, <16384 medium, else high), `enabled: false` asks for the lowest level, and `exclude: true` omits thinking text from the reply. A top-level `reasoning_effort` wins over it. `response_format` `json_object` / `json_schema` (and Responses `text.format`) are **best-effort**: Cursor has no constrained decoding, so the gateway appends a JSON instruction (with the schema) to the prompt it sends upstream and, for non-streaming replies, strips a surrounding ```` ```json ```` fence; a reply that still is not valid JSON is returned unchanged and logged (`json output requested but the reply is not valid JSON`). The schema is not validated. See `enforce_output_limits` for `max_tokens` / `stop`.

Usage follows OpenAI semantics: `prompt_tokens` includes cached tokens (`prompt_tokens_details.cached_tokens` = cache reads; cache writes are also returned as `cache_write_tokens`), `completion_tokens_details.reasoning_tokens` appears when the model reports it, and `total_tokens = prompt_tokens + completion_tokens`. Request logs store `input_tokens` the same way; on upgrade, older rows are rewritten once (`input + cache read + cache write`, gated by `PRAGMA user_version` < 11), so admin token aggregates never mix the two semantics. **Breaking** for clients that add `cached_tokens` to `prompt_tokens` themselves or reconcile on `prompt_tokens`. `conversation_id` (or `metadata.conversation_id`) resumes the same Cursor agent for that client key; IDs are limited to 512 UTF-8 bytes and the newest 1,000 mappings per client key are retained. Tool parks time out after `park_timeout_ms` (default 300000); after a gateway restart, tool results continue from the HTTP transcript.

The Cursor SDK accepts each turn as one prompt rather than native OpenAI role messages. This gateway serializes `system` / `developer` / `user` roles into transcript text, so application-supplied `system` or `developer` messages are context, not a hard security boundary against hostile user content.

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

The overview shows the running version, commit, database schema, and effective runtime settings (read-only). Request logs translate common failure codes while retaining the original code and display Max mode as Max, Standard, or Not recorded; an unrecorded mode does not establish whether an upstream request ran or incurred charges.

The client key list shows remaining requests, remaining tokens, the reset time, and the quota time zone. Policy edits validate inputs, prevent duplicate save/reset operations while pending, and preserve inputs on failure.

Request logs store upstream-reported `raw_cost_cents`, `charged_cents`, and `cost_scope` independently of detailed body logging. `cost_scope: "agent_total"` denotes an **Agent cumulative cost snapshot** in float cents. Upstream billing events may arrive late, so snapshots may be incomplete and must not be summed as individual request costs. Unknown costs and pre-upgrade records remain `null`; explicitly reported zero costs remain `0`. Cost metadata follows request log retention, is not a permanent billing ledger, and does not impose a hard monetary limit.

Admin API: `/admin/api/*` with the same `admin_access_key` (`Authorization: Bearer` or `X-Management-Key`). `DELETE /admin/api/keys/{id}` removes a client key and keeps its request logs. `GET /admin/api/system-logs` lists gateway stdout/stderr events stored in SQLite. `GET /admin/api/cursor-keys` shows the upstream key pool (sha256 fingerprint, `healthy` / `cooling_down`, failure counters; keys are never returned). The overview includes `cursor_keys: {total, healthy}`.

### Per-key model policy and quotas

Each client key can carry its own policy. Every field is optional; existing keys (and new keys created without these fields) stay unrestricted, so upgrading changes nothing until you set one.

| Field | Meaning |
| --- | --- |
| `allowed_models` | `null` = any model. Otherwise a list of exact model ids or `*` wildcards (case-insensitive), e.g. `["gemini-*", "composer-2.5"]`. Checked after `model_aliases` and again on the catalog id the model resolves to, so an alias cannot unlock a model the list does not allow. Wildcards match catalog ids only; a catalog alias must be listed exactly. `GET /v1/models` only lists allowed models and `GET /v1/models/{id}` returns 404 for the rest. A disallowed model returns `403 model_not_allowed` (`param: "model"`). |
| `allow_max_mode` | `null` = inherit the gateway `allow_max_mode`. `false` turns max mode off for this key. The gateway setting is a **hard ceiling**: effective = gateway **AND** key, so `true` cannot enable max mode when the gateway has `allow_max_mode = false`. Admin responses include `effective_allow_max_mode`, plus a `warnings` entry when `true` is capped by the gateway; the console shows the effective state. Same fallback / `403 max_mode_not_allowed` behaviour, including the check of the SDK-resolved model. |
| `quota_requests` | Maximum requests per period. Pre-charged atomically before the upstream run (concurrent requests cannot overspend) and refunded if the run never starts. |
| `quota_tokens` | Token budget per period, a **soft cap**. At admission each request atomically **reserves** the larger of: an input estimate (characters / 4, plus 1,024 output tokens), or the key's average actual usage over its last `quota_reserve_recent_runs` runs (default 20, in memory per process). It is admitted only while used + reserved tokens are below the limit. On finish the reservation is replaced by the actual charge (see *Token accounting*). So concurrent requests cannot all pass a nearly used quota. For example, 100 concurrent runs of ~20k tokens under a 100k quota admit about 5. Overrun bound: quota − 1 + Σ(actual − reservation)⁺ over the admitted requests. That sum is small once the key has history; it can be large on a cold start, while every reservation is still the input estimate. |
| `quota_period` | `total` (default, never resets), `daily` or `monthly`. |
| `quota_tz` | IANA time zone for period boundaries (default `UTC`), e.g. `Asia/Singapore`. Stored canonical (`asia/singapore` → `Asia/Singapore`); UTC offsets such as `+08:00` are rejected. A stored zone the runtime no longer knows falls back to UTC (logged). Midnight-DST zones (Havana, Azores, …): the day starts at its first existing local instant. |
| `max_concurrent` | Maximum in-flight requests for the key (per gateway process; multiply by the number of instances). Agents suspended on client tool calls also hold a slot until their tool results arrive (the continuing request reuses it) or the park times out. |
| `quota_cache_read_weight` | `null` = gateway `quota_cache_read_weight` (env `QUOTA_CACHE_READ_WEIGHT`, default `1.0`). A number from 0 to 1: how much each cache-read token counts toward `quota_tokens` (e.g. `0.1` ≈ cache-read pricing). |

Over quota: `429 insufficient_quota` with `Retry-After` (seconds until the period resets; omitted for `total`). Over the concurrency cap: `429 concurrency_limit_exceeded` with `Retry-After: 1`. Model checks run first, so a disallowed model gets 403/404, not 429, and is not charged.

Admin API: `POST /admin/api/keys` accepts the fields above; `PATCH /admin/api/keys/{id}` updates any of them (plus `name`; omitted fields are unchanged, `null` clears a limit); `GET /admin/api/keys/{id}/usage` returns the current period (`requests`, `tokens`, `remaining_*`, `in_flight`, `resets_at`) and recent periods; `POST /admin/api/keys/{id}/usage/reset` zeroes the current period. `GET /admin/api/keys` includes each key's policy and `usage_current`. The admin UI edits these under **Client keys → Policy**.

Token accounting limits:
- Charge per request, in order: (1) the SDK's per-run usage (`run.wait().usage`); for runs that were aborted or failed after starting, the larger of that usage and the estimate in (2), so partial or zero usage reported after a cancel never undercharges; (2) otherwise a conservative estimate: input sent upstream plus streamed text, thinking and tool-call arguments, at ~4 characters per token (client abort without usage, cumulative-only usage); (3) if nothing at all is known (the run failed after starting), the admission reservation stays as the charge. Cumulative agent totals are never charged, because they would double count continued conversations. The source is pluggable for a future per-run usage API.
- Turns that end in client tool calls (suspended runs) are charged the estimate when the response is sent, so an abandoned tool round is never free. When the tool results come back and the run finishes, the run's actual usage minus what was already charged is added (never negative).
- A request whose run never started (validation errors, failed send) is refunded: request count and reservation.
- Database: `PRAGMA user_version` records the schema version (11). Rolling back to a build older than v10 ignores the policy columns, i.e. **every client key becomes unrestricted**; upgrading again restores the policies.
  - Usage made while rolled back is not back-filled into `api_key_usage` after upgrading again.
  - On the old build, deleting a key leaves its `api_key_usage` rows behind (orphans; harmless, not counted).
  - Upgrading from a schema below 11 adds cached reads/writes to historical `request_logs.input_tokens` once and records version 11. Back up SQLite using its online backup API, or stop the gateway and back up its data directory before upgrading; rolling back code does not undo these counts.
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

Use `npm run test:unit` for the fast unit suite. `npm test` also runs the loopback HTTP authentication smoke test. Tests never touch the network: every gateway they start uses the fake Cursor SDK (`tests/fixtures/fake-cursor-sdk.mjs`), and `scripts/run-tests.mjs` preloads a guard (`tests/fixtures/no-network.mjs`, via `NODE_OPTIONS`, so child processes are covered) that blocks and records non-loopback TCP/TLS connections (`net`, `tls`, `http`, `https`, `http2`, `fetch`), DNS lookups and queries, and UDP sends; `localhost` is allowed only when it resolves to loopback. Any recorded attempt fails the run, even when the code swallowed the error. Temp dirs created by tests live in a run-scoped `TMPDIR` that is removed afterwards. `CURSOR_API_TEST_ALLOW_NETWORK=1` disables the guard (no test needs it). The JS guard cannot see child processes started without its `NODE_OPTIONS`, worker threads or native binaries, so on Linux `npm run test:offline` runs the suite in an empty network namespace (`unshare -rn`) with `CURSOR_*` and key/token/secret-like variables removed; CI runs `test:offline`.

`npm run test:tmpdirs` checks for leaked `cursor-api-*` temporary directories.

The test suite also exercises the official OpenAI Node SDK against the gateway with a fake Cursor upstream: Chat/Responses, streams, tools, retrieval, and typed errors.

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
