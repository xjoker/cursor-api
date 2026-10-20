# cursor-api

[English](README.md) | 简体中文

> 本文是英文 README 的中文译本，内容以英文版为准。

**把 Cursor 模型暴露成 OpenAI 兼容接口。** 使用 OpenAI 请求格式的客户端指向 `/v1` 即可接入；在管理台签发客户端 Key、查看请求日志。单元测试覆盖标准 OpenAI 请求格式，以及 Codex、OpenCode 发送的请求形态，但这不是用这些客户端做的端到端测试。仅部分兼容：不支持音频，Chat Completions 对 `temperature` / `top_p` / `seed` 默认返回 400。详见[客户端接入](#客户端接入)。

> **非官方项目。** `cursor-api` 与 Cursor（Anysphere, Inc.）和 OpenAI 均无关联，也未获其认可。文中提到这些名称仅用于说明兼容对象。
>
> **服务条款风险：** 使用本网关可能违反 Cursor 的[服务条款](https://cursor.com/terms-of-service)或[可接受使用政策](https://cursor.com/acceptable-use-policy)，可能导致 Cursor 账号被暂停或终止。使用风险由你自行承担。
>
> **使用范围：** 只使用你自己的 Cursor API Key（即上游的 `cursor_api_key`，不是网关签发的 `cgk_` 客户端 Key），仅供本机个人使用。不要多人共用你的 Cursor API Key，也不要把网关作为公共服务对外提供。使用时请遵守 Cursor 的条款。

**变更记录：** [`CHANGELOG.md`](./CHANGELOG.md)

**你需要：** [Docker Compose](https://docs.docker.com/compose/) 和 [Cursor User API Key](https://cursor.com/settings)。

> **⚠️ 破坏性变化（下个版本）：默认监听地址改为 `127.0.0.1`。** 未设置 `host` 或 `GATEWAY_HOST` 时，网关只接受本机连接。**受影响：** 不用 Docker（PM2 / systemd / `NODE_ENV=production npm start`）又要从其他机器访问的用户，以及不使用本仓库 `Dockerfile` 的自制容器镜像。官方镜像和 compose 文件在容器内仍监听 `0.0.0.0`。要重新监听所有网卡，设置 `host = "0.0.0.0"` 或 `GATEWAY_HOST=0.0.0.0`。**风险：** 这会把网关（以及背后的 Cursor 账号）暴露给主机能连到的所有网络，只应在防火墙或反向代理之后这样做。详见 [升级说明：监听地址](#升级说明监听地址)。

## 四步部署

**不用 clone 仓库。** 建个目录，把下面的 `docker-compose.yml` 存进去，拉 `ghcr.io/xjoker/cursor-api:latest` 即可。

1. **保存 compose 并启动** — `docker compose up -d`
2. **自动生成配置** — `data/config/gateway.toml`（空模板）
3. **改配置** — 填入三把密钥（见下）
4. **重启** — `docker compose restart` → `http://127.0.0.1:8787`

---

## 1. `docker-compose.yml` + 启动

任意目录下保存为 `docker-compose.yml`：

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

启动：

```bash
mkdir -p cursor-api && cd cursor-api
# 把上面的 yaml 写入 docker-compose.yml
mkdir -p data
docker compose up -d
```

第一次可能因密钥未填而退出，正常；`./data/config/gateway.toml` 仍会自动生成。

**仅 Linux — 改完配置后容器读不到文件时：** `gateway.toml` 是 `chmod 600`（只有文件主人能读），容器进程的用户 ID 必须和文件主人一致。在**第一次**启动前执行：

```bash
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

（compose 里的 `GATEWAY_UID` / `GATEWAY_GID` = 容器用哪个 Linux 用户身份跑，默认 `1000`。macOS / Windows 的 Docker 一般不用管。）

**若以前 compose 服务名还是 `gateway`：** 先清掉孤儿容器，否则 8787 端口可能被旧容器占着：

```bash
docker compose down --remove-orphans
docker compose up -d
```

---

## 2. 编辑 `data/config/gateway.toml`

编辑容器生成的 `./data/config/gateway.toml`。

```toml
# host = "0.0.0.0"  # 不写 = 镜像默认 0.0.0.0；写了以这里为准（环境变量 GATEWAY_HOST 优先于两者）
port = 8787

cursor_api_key = "你的-cursor-user-api-key"
admin_access_key = "随机长串-管理密钥"
api_key_pepper = "随机长串-HMAC-盐"
# park_timeout_ms = 300000

[logs]
retention_days = 7
max_rows = 100000
detailed = false
```

| 键 | 含义 |
|----|------|
| `cursor_api_key` | Cursor 账号 Key（上游） |
| `admin_access_key` | 管理台登录密钥 |
| `api_key_pepper` | 客户端 Key 哈希用的随机串 |
| `[logs].retention_days` | 请求日志保留天数（1–3650），默认 **7** |
| `[logs].max_rows` | SQLite 请求日志行数上限（1k–10M），先删最旧 |
| `[logs].detailed` | 记录请求/响应 JSON，管理台点击日志可查看（默认 **false**）。正文以**明文**存在 `./data`，请保护数据目录 |
| `[logs].detailed_max_bytes` | 单条请求/响应 JSON 上限（4KiB–1MiB，默认 64KiB） |
| `[logs].max_detail_bytes` | `model` + 详细正文合计 UTF-8 字节上限（默认 256MiB），超限先删最旧行 |
| `cursor_api_keys` | 可选的额外 Cursor key，逗号分隔（环境变量 `CURSOR_API_KEYS`）。与 `cursor_api_key` 一起组成 key 池：新建 agent 时在健康 key 间轮询；某个 key 返回上游认证错误或限流时进入冷却，本次请求自动切到下一个 key。已经向客户端输出内容后不再切换；待回传结果的工具轮次继续在原 agent（原 key）上执行 |
| `cursor_key_cooldown_ms` | 限流后的冷却时间（默认 **60000**，1 秒–24 小时），连续失败翻倍，最多 8 倍。认证失败冷却 15 分钟 |
| `cursor_key_strategy` | `round_robin`（默认）轮流使用各 key；`least_active` 把每个请求发给当前进行中请求最少的健康 key，持平时轮流。`GET /admin/api/cursor-keys` 返回每个 key 的 `active_requests`、`successes`、`failures`、`last_used_at` |
| `park_timeout_ms` | 工具轮次在内存里保留多久（默认 **300000**）。网关重启后，下一次工具结果按 HTTP transcript 续场 |
| `max_live_sessions` | 内存中运行和等待工具结果的 Cursor 会话上限（默认 **256**）；正在创建的会话也计入上限 |
| `conversation_ttl_days` | 未使用的持久化 `conversation_id` 映射保留天数（默认 **30**） |
| `ignore_sampling_params` | 丢弃 Chat Completions 不支持的采样参数而不返回 400（默认 **false**） |
| `allow_max_mode` | 是否允许 Cursor **max mode**（环境变量 `ALLOW_MAX_MODE`，默认 **true**）。当前锁定的 `@cursor/sdk` 会在「与解析出的参数匹配的目录变体全部是 max-only」时自动开启 max mode，按更高费率计费。网关以模型的默认变体为基础参数，所以默认变体是 max-only 的模型（例如默认长上下文）只写模型名就会走 max。设为 `false`：网关会换成保留客户端显式选择的最接近的非 max 变体；只有 max 变体能满足的请求（max-only 模型，或 `variant`/`params`/`reasoning_effort` 指向 max 变体）返回 `403 max_mode_not_allowed`。Anthropic 的 `output_config.effort` 属于软提示，会被丢弃而不是报错。每条请求日志都会记录 `max_mode` |
| `quota_cache_read_weight` | 缓存读 Token 计入按 Key `quota_tokens` 的权重（0–1，环境变量 `QUOTA_CACHE_READ_WEIGHT`，默认 **1.0**）；Key 自己的 `quota_cache_read_weight` 优先 |
| `sse_keepalive_ms` | 空闲流式响应发送 `: keepalive` 注释的间隔（默认 **15000**；`0` 关闭） |
| `cors_allow_origins` | 浏览器跨域来源，默认 `"*"`；用逗号分隔精确来源（如 `"https://app.example.com,http://localhost:5173"`），空字符串关闭 CORS。环境变量 `CORS_ALLOW_ORIGINS` 可覆盖，包括空值 |
| `auth_failure_limit` | 每个客户端地址在任意 60 秒滑动窗口内允许的认证失败次数（默认 **20**，最大 1000；`0` 关闭）。管理密钥和客户端 Key 分开计数。**管理端：**达到上限后，该地址的所有管理请求（包括正确密钥）都返回 `429` 和 `Retry-After`，直到窗口内的失败数回落。**客户端 Key：**正确的 Key 永远不会被限流，只有继续使用错误 Key 的请求会返回 `429` + `Retry-After`（代替 `401`）。不带任何 Key 的请求不计数。IPv6 按 /64 合并计数 |
| `trusted_proxies` | 反向代理的 IP 或 CIDR，逗号分隔，例如 `"127.0.0.1, 172.18.0.0/16"`（环境变量 `TRUSTED_PROXIES`）。默认为空：TCP 对端地址即客户端地址，忽略 `X-Forwarded-For`。对端在列表中时，取 `X-Forwarded-For` 从右往左第一个不在列表中的地址。在反代后面却不配置此项时，所有客户端在 `auth_failure_limit` 中共用代理地址。只填写会覆盖或追加 `X-Forwarded-For` 的代理（nginx `proxy_add_x_forwarded_for`、Caddy 默认行为） |

会话在重启后仍绑定创建它的 Cursor Key，SQLite 仅保存指纹。移除所属 Key 后，增量续接会明确报错；发送完整历史可重放。旧映射没有归属信息时，多 Key 模式需要完整历史。

```bash
chmod 600 data/config/gateway.toml
```

---

## 3. 重启

```bash
docker compose restart
curl -s http://127.0.0.1:8787/health
```

应看到 `"status":"ok"`。拉新镜像后，用 `version` / `git_commit` 和你期望的 tag 对一下——registry push 成功不等于正在跑的容器已更新：

```bash
docker compose pull && docker compose up -d
curl -s http://127.0.0.1:8787/health
# {"status":"ok","version":"20260828.10","git_commit":"<sha>","schema_version":6}
```

---

## 4. 接入客户端

1. 浏览器打开 **http://127.0.0.1:8787/admin/**，填入 `admin_access_key`。
2. **客户端 Key** → 创建 Key（`cgk_` 开头），只显示一次。
3. 客户端配置：

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<你的 cgk_ 客户端 Key>
```

**快速测试：**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cgk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Reply with PONG only."}]}'
```

---

## 客户端接入

**认证：** `Authorization: Bearer cgk_...` 或 `X-Api-Key: cgk_...`

| 方法 | 路径 | 常见客户端 |
|------|------|------------|
| `POST` | `/v1/chat/completions` | OpenAI SDK、OpenCode `"npm": "@ai-sdk/openai-compatible"` |
| `POST` | `/v1/responses` | Codex、OpenCode `"npm": "@ai-sdk/openai"` |
| `POST` | `/v1/messages` | Anthropic SDK、兼容 Claude 的客户端 |
| `GET` | `/v1/models`、`/v1/models/{id}` | 模型列表 |

支持流式（`stream: true`）、视觉（`image_url`，以及 OpenCode 的 `image` / 图片 `file` 部件）、思考块（`delta.reasoning_content`）、Cursor 参数（`params`、`variant`、`reasoning_effort` 等）。`variant` 匹配唯一的目录显示名；当 Cursor 把所有 variant 都起成同一个显示名时，改为匹配 effort/reasoning/fast 的值（OpenCode `--variant high` 在 `@ai-sdk/openai-compatible` 上不会发出该字段；请在请求体里发 `variant` 或 `reasoning_effort`）。支持 OpenAI 工具调用（`tools` / `tool_calls` / `role: tool`），供 OpenCode 等客户端在本地执行工具。Cursor 的 shell/文件工具保持关闭；仅在有客户端工具时打开 MCP，用来把这些工具暴露给模型。不支持音频。`temperature` / `top_p` / `seed` 会 400；`max_tokens` 仍接收。`reasoning_effort` 按尽力而为处理：精确匹配模型取值，否则取最接近档位；模型没有 effort 参数时忽略（布尔型思考开关：`none`/`minimal` 映射为关）。

Usage 按 OpenAI 语义：`prompt_tokens` 包含缓存 Token（`prompt_tokens_details.cached_tokens` = 缓存读；缓存写另外以 `cache_write_tokens` 返回），模型上报时带 `completion_tokens_details.reasoning_tokens`，`total_tokens = prompt_tokens + completion_tokens`。请求日志的 `input_tokens` 也按此口径（本次改动之前写入的行是不含缓存的 input）。`conversation_id`（或 `metadata.conversation_id`）按客户端 Key 续同一个 Cursor Agent；ID 最多 512 个 UTF-8 字节，每个客户端 Key 保留最近 1000 条映射。工具停车超时为 `park_timeout_ms`（默认 300000）；网关重启后，工具结果按 HTTP transcript 续场。

Cursor SDK 每轮接收的是单个 prompt，并不原生接收 OpenAI 角色消息。本项目会把 `system` / `developer` / `user` 角色序列化进 transcript 文本；因此应用传入的 `system` 或 `developer` 消息只能作为上下文，不能充当抵御恶意用户内容的硬安全边界。

### Anthropic Messages（`POST /v1/messages`）

Anthropic SDK / 兼容 Claude 的工具把 base URL 指向网关根地址（SDK 会自己拼 `/v1/messages`）：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<你的 cgk_ 客户端 key>      # 以 x-api-key 发送
```

- 支持 `system`（字符串或 text 块）、`text` / `image`（base64 或 URL）块、`stream: true`（`message_start` → `content_block_*` → `message_delta` → `message_stop`），思考内容以 `thinking` 块输出。
- 客户端工具：`tools[].input_schema` → `tool_use` 块 + `stop_reason: "tool_use"`；下一轮 user 消息里回传 `tool_result`（`is_error: true` 会作为错误结果交给模型）。与 `tool_result` 同时出现的额外文本会附加到最后一个结果上。没有 `input_schema` 的服务端工具（`web_search_…`、`bash_…`）会被忽略。
- `tool_choice`：`auto`、`tool`、`none`；`any` 退化为 `auto`（Cursor 无法强制调用工具）。
- 忽略：`temperature`、`top_p`、`top_k`、`thinking`、`output_config`、`context_management`、`service_tier`。未知顶层字段也会忽略。拒绝：非空 `stop_sequences`、`document` 块。
- Cursor 参数（`params`、`variant`、`reasoning_effort`、`verbosity`、`fast`、`optimize_for`）以及 `conversation_id` / `metadata.conversation_id` 与 Chat Completions 一致。
- 错误为 Anthropic 格式：`{"type":"error","error":{"type":"invalid_request_error","message":"…"}}`。
- `usage` 的 `input_tokens`（不含缓存，Anthropic 语义）/ `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` 来自 Cursor token 用量；非流式响应附带 `cursor.cost`。
- `POST /v1/messages/count_tokens` 返回粗略估算（见下方 Claude Code）。

### Claude Code

Claude Code CLI 2.x 可以直接连 `/v1/messages`（已用 `claude -p` 验证，包括 Bash 工具往返、`/context` 和流式）：

```bash
# gateway.toml（或环境变量 MODEL_ALIASES）：把 Claude 模型名映射到 Cursor 模型
#   model_aliases = "claude-haiku-*=composer-2.5, claude-*=composer-2.5"
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=cgk_你的key          # 以 x-api-key 发送
claude -p "Reply with PONG"
```

网关对 Claude Code 请求的处理：

- 带 `anthropic-beta` 的 `POST /v1/messages?beta=true`：所有 beta 标志和未知顶层字段（`context_management`、`safeguards`、`output_config` 等）都会接受并忽略。
- Claude 模型名（`claude-opus-*`、`claude-sonnet-*`，以及后台任务用的 `claude-haiku-*`）经过 `model_aliases` 映射：先匹配先生效，`*` 是通配符，对所有接口生效；没有匹配时原样查 Cursor 模型目录，查不到会返回 `not_found_error`。
- `messages` 里的 `system` 消息会作为 `[system]` 上下文并入前一条 user / tool 消息，这样工具轮次能继续命中停车的 Cursor 会话，不必重放整个 transcript。
- `thinking` / `output_config.effort` 映射为尽力而为的推理档位（effort `low`–`max`；`budget_tokens` <4k → low，<16k → medium，否则 high；`disabled` → 最低档）。没有 effort 参数的模型忽略。
- 历史里的服务端工具块（`server_tool_use`、`web_search_tool_result` 等）会跳过，`cache_control` 会忽略。
- `POST /v1/messages/count_tokens` **默认返回 404**，因为 SDK 没有精确 tokenizer。设置 `anthropic_count_tokens = "estimate"`（环境变量 `ANTHROPIC_COUNT_TOKENS`）可启用粗略本地估算（响应头 `x-token-count-estimated: true`；约 4 个 ASCII 字符或 1 个非 ASCII 字符算 1 个 token）。估算有误差，可能影响客户端上下文压缩判断，不能视为真实用量。
- `HEAD /api/hello`（Claude Code 的连通性探测）返回 404，Claude Code 能容忍。

### Codex（`POST /v1/responses`）

把 Codex 指到本网关的 `/v1`。压缩（`/compact`）请求可被接受：Responses 接受 `parallel_tool_calls: false` 和 `tools: []`（该开关会被忽略，Cursor 不区分）。Chat Completions 对 `parallel_tool_calls: false` 仍 400。

Responses 还会收下并忽略采样参数（`temperature`、`top_p` 等）以及未知顶层字段（`client_metadata`、`include` 等）。Codex 的 `custom` 工具（`apply_patch`）往返发 `custom_tool_call` 和自由格式 `input`。嵌套 `namespace` 工具摊平成 function。没有 name 的 hosted 工具（`web_search` 等）直接丢掉。上一轮的 assistant 正文和 `function_call` 会并成一条消息，避免工具结果 400。`previous_response_id` 续同一个 Cursor Agent。`reasoning.effort` 按尽力而为处理：模型有 effort 参数时映射过去（精确匹配，否则取最接近的档位，如 `xhigh` → `high`、`minimal` → `low`），模型没有该参数时忽略，所以 Codex 的默认请求不会 400。顶层 `reasoning_effort`（Responses 和 Chat Completions）规则相同：只有既不是模型的取值、也不是标准档位（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）的值才返回 400。模型本身列出的值视为显式选择，所以 `allow_max_mode` 规则照常生效。

### OpenCode

`"npm": "@ai-sdk/openai"` 走 Responses。`"npm": "@ai-sdk/openai-compatible"` 走 Chat Completions。要用 `-f` 贴图和 `--thinking` 时，在 `opencode.json` 里给模型打开能力：

```json
"grok-4.5": {
  "name": "Cursor Grok 4.5",
  "attachment": true,
  "reasoning": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

`variant` 匹配唯一的目录显示名；当 Cursor 把所有 variant 都起成同一个显示名时，改为匹配 effort/reasoning/fast 的值。OpenCode `--variant high` 在 `@ai-sdk/openai-compatible` 上不会发出该字段；请在请求体里发 `variant` 或 `reasoning_effort`。

### Chat Completions

支持流式（`stream: true`）、视觉（`image_url`，以及 OpenCode 的 `image` / 图片 `file` 部件）、思考块（`delta.reasoning_content`）、Cursor 参数（`params`、`variant`、`reasoning_effort` 等），以及 OpenAI 工具调用（`tools` / `tool_calls` / `role: tool`），供本地客户端执行工具。Cursor 的 shell/文件工具保持关闭；仅在有客户端工具时打开 MCP。

不支持音频。`temperature` / `top_p` / `seed` 会 400；`max_tokens` 仍接收。`conversation_id`（或 `metadata.conversation_id`）按客户端 Key 续同一个 Cursor Agent。工具停车超时为 `park_timeout_ms`（默认 300000）；网关重启后，工具结果按 HTTP transcript 续场。

Max mode：`GET /v1/models` 会给 max-only 变体加上 `is_max_mode: true`。如果某个模型的默认变体是 max-only，又不想走 max，请显式选择非 max 变体（例如 `params: [{"id":"context","value":"256k"}]`），或设置 `allow_max_mode = false`。请求切换到另一个 Cursor Key 或重放会话时，会重新解析模型；允许 max mode 时，每次真正跑起来的尝试都按 max 计费。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="cgk_YOUR_KEY")
print(client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

---

## 管理台

浏览器访问 `/admin/`：总览（含近 7 天调用曲线）、客户端 Key（创建 / 停用 / 恢复 / 删除 / 策略与配额）、请求日志、系统日志。

管理 API：`/admin/api/*`，用同一把 `admin_access_key`（`Authorization: Bearer` 或 `X-Management-Key`）。`DELETE /admin/api/keys/{id}` 删除客户端 Key，历史请求日志保留。`GET /admin/api/system-logs` 列出写入 SQLite 的网关 stdout/stderr 事件。`GET /admin/api/cursor-keys` 查看上游 key 池状态（sha256 指纹、`healthy` / `cooling_down`、失败计数；不返回 key 本身）。概览接口包含 `cursor_keys: {total, healthy}`。

### 按 Key 的模型策略与配额

每把客户端 Key 都可以单独设置策略，所有字段都可选。已有的 Key（以及创建时没带这些字段的新 Key）默认不受限制，升级后什么都不会变，直到你主动设置。

| 字段 | 含义 |
| --- | --- |
| `allowed_models` | `null` = 不限模型；否则是精确模型 id 或 `*` 通配（不区分大小写）的列表，例如 `["gemini-*", "composer-2.5"]`。在 `model_aliases` 映射之后检查，并对解析出的目录 id 再检查一次，所以别名无法绕过白名单。通配只匹配目录 id，目录别名必须精确列出。`GET /v1/models` 只列出允许的模型，`GET /v1/models/{id}` 对其余模型返回 404。不允许的模型返回 `403 model_not_allowed`（`param: "model"`）。 |
| `allow_max_mode` | `null` = 继承网关的 `allow_max_mode`；`true` / `false` 为该 Key 双向覆盖全局设置，回退 / `403 max_mode_not_allowed` 行为与全局一致。 |
| `quota_requests` | 每周期最多请求数。在上游 run 之前原子预扣（并发请求不会超额），run 没有启动则退还。 |
| `quota_tokens` | 每周期 Token 额度，属于**软上限**：已用 Token 低于额度就放行，请求结束后再累加，所以最后一个请求可能超出。 |
| `quota_period` | `total`（默认，永不重置）、`daily`、`monthly`。 |
| `quota_tz` | 计算周期边界用的 IANA 时区（默认 `UTC`），例如 `Asia/Singapore`。 |
| `max_concurrent` | 该 Key 同时进行中的最大请求数（按网关进程计）。 |
| `quota_cache_read_weight` | `null` = 继承网关 `quota_cache_read_weight`（环境变量 `QUOTA_CACHE_READ_WEIGHT`，默认 `1.0`）。0 到 1 的数字：每个缓存读 Token 在 `quota_tokens` 中按多少计（例如 `0.1` 约等于缓存读的价格比例）。 |

超出配额返回 `429 insufficient_quota`，带 `Retry-After`（距下个周期的秒数；`total` 不带）。超出并发上限返回 `429 concurrency_limit_exceeded`，`Retry-After: 1`。模型检查在配额之前，所以不允许的模型得到 403/404 而不是 429，也不扣次数。

管理 API：`POST /admin/api/keys` 接受以上字段；`PATCH /admin/api/keys/{id}` 修改任意字段（以及 `name`；没传的字段不变，传 `null` 表示取消限制）；`GET /admin/api/keys/{id}/usage` 返回本周期用量（`requests`、`tokens`、`remaining_*`、`in_flight`、`resets_at`）和最近几个周期；`POST /admin/api/keys/{id}/usage/reset` 把本周期清零。`GET /admin/api/keys` 会带上每把 Key 的策略和 `usage_current`。管理台在 **客户端 Key → 策略** 中编辑。

Token 计量的限制：
- Token 取自 SDK 每次 run 的用量（`run.wait().usage`）。Agent 累计总量永远不计入，否则续会话会重复计算。用量来源可插拔，便于以后接入官方的按 run 用量接口。
- 以客户端工具调用结束的轮次（挂起的 run）在返回响应时可能还没有用量；这些轮次照常计入 `quota_requests`，但计入的 Token 可能少于实际消耗。
- 暂不支持按费用（美元）设配额：本地 SDK Agent 不提供单次请求的费用。

---

## 配置说明

唯一配置文件：`data/config/gateway.toml`。可选覆盖见 [`.env.example`](./.env.example)。

**优先级：** 环境变量 → `.env` → TOML → 默认值。

**监听地址**（优先级从高到低）：

1. 环境变量 `GATEWAY_HOST`（`docker run -e`、compose `environment:`、PM2 `env`、systemd `Environment=`、`.env`）
2. `gateway.toml` 里的 `host`
3. `GATEWAY_DEFAULT_HOST`——Docker 镜像把它设为 `0.0.0.0`，让映射端口开箱可用；不需要手动设置
4. `127.0.0.1`（仅本机）

也就是说：在 Docker 里，除非 `gateway.toml` 另有设置，容器监听 `0.0.0.0`；不用 Docker 时监听 `127.0.0.1`。如果 `GATEWAY_HOST` 覆盖了 `gateway.toml` 里不同的 `host`，启动时会打一条 `warn` 日志。端口映射的宿主机一侧请保持回环（`127.0.0.1:8787:8787`），除非确实要对外暴露，不要去掉 `127.0.0.1:` 前缀。

SQLite 与工作区在 `./data`。请求日志和系统日志按 `[logs]` 在写入时和启动时自动清理。容器 stdout 由 compose 的 `logging.options` 轮转（约 30 MB 上限）。

---

## 升级说明：监听地址

**破坏性变化——非 Docker 部署默认只监听 `127.0.0.1`。**

- **变化：** `gateway.toml` 没有 `host`、也没有 `GATEWAY_HOST` 时，网关现在监听 `127.0.0.1`。旧版本在 `NODE_ENV=production` 下监听 `0.0.0.0`。
- **受影响（远程访问会断）：**
  - 不用 Docker、以 `NODE_ENV=production` 运行（PM2、systemd 等）并从其他机器访问，且 `gateway.toml` 里没有 `host`、也没有设置 `GATEWAY_HOST` 的部署；
  - 不用本仓库 `Dockerfile`、自己用镜像或 entrypoint 跑 `node dist/index.js` 的容器（拿不到 `GATEWAY_DEFAULT_HOST=0.0.0.0`），映射端口会不通。
- **现象：** 升级后在服务器本机 `curl http://127.0.0.1:8787/health` 正常，其他机器连不上（connection refused）。
- **自查：** `ss -ltnp | grep 8787`，看到 `127.0.0.1:8787` 就说明受影响。
- **恢复监听所有网卡**，改完重启：
  - `gateway.toml`：加上 `host = "0.0.0.0"`；或者
  - PM2：在 ecosystem 文件里写 `env: { GATEWAY_HOST: "0.0.0.0" }`，然后 `pm2 restart <app> --update-env`；或者
  - systemd：在 unit（或 drop-in）里写 `Environment=GATEWAY_HOST=0.0.0.0`，然后 `systemctl daemon-reload && systemctl restart <unit>`。
  - 自制镜像：`ENV GATEWAY_DEFAULT_HOST=0.0.0.0`（`gateway.toml` 的 `host` 仍然说了算）或 `-e GATEWAY_HOST=0.0.0.0`。
- **风险：** `0.0.0.0` 会把网关（以及背后的 Cursor 账号）暴露给主机所在的所有网络。请放在防火墙或反向代理之后，使用强 `admin_access_key` 和客户端 Key；除非确实要对外发布，Docker 端口映射保持 `127.0.0.1:` 前缀。Docker 的 `-p` 规则会绕过 ufw。
- **不受影响：** 官方镜像和仓库自带的 compose 文件（容器内仍监听 `0.0.0.0`，宿主机一侧端口仍是 `127.0.0.1:8787`）；配置里已经有 `host = "0.0.0.0"` 的用户（包括旧版本自动生成的配置）。
- **Docker 说明：** 镜像现在设置的是 `GATEWAY_DEFAULT_HOST=0.0.0.0`，不再是 `GATEWAY_HOST`，所以挂载的 `gateway.toml` 里写的 `host` 在容器内会生效。

---

## 本地开发

改代码或跑测试时再 clone 仓库：

```bash
git clone https://github.com/xjoker/cursor-api.git && cd cursor-api
npm ci && npm run dev
```

快速单元测试用 `npm run test:unit`；`npm test` 还会运行回环 HTTP 鉴权冒烟测试。

需 Node **22.13+** 与 `data/config/gateway.toml`。本地编译镜像见 [`docker-compose.yml`](./docker-compose.yml)。构建时传入 git SHA，`/health` 的 `git_commit` 才不是 `unknown`：

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose build
```

---

## 健康检查

镜像自带 Docker `HEALTHCHECK`，按环境变量和 TOML 中的实际监听地址、端口探测 `/health`。此检查只验证网关进程存活，不代表 Cursor 密钥有效或模型可用。

| 端点 | 用途 |
|------|------|
| `GET /health` | 存活：`status`、`version`、`git_commit`、`schema_version` |
| `GET /` | JSON 接口说明（curl）或跳转管理台（浏览器） |

`version` 来自 [`VERSION`](./VERSION)。GHCR 打 tag 之后，先 pull/重启容器，再对 `/health`，不要假设新构建已经在跑。

---

## 许可证

[MIT](./LICENSE)。MIT 许可只覆盖本仓库的代码。第三方依赖适用各自的许可；其中 `@cursor/sdk` 及其平台包（如 `@cursor/sdk-linux-x64`）是专有许可（© Anysphere Inc.，保留所有权利），并会被打包进发布的 Docker 镜像。
