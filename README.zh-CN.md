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
    stop_grace_period: 30s
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
| `[logs].detailed` | 记录请求/响应 JSON，管理台点击日志可查看（默认 **false**）。正文以**明文**存在 `./data`，请保护数据目录。像凭据的内容（`Bearer …`、`api_key=…`、`cgk_…`，以及 `authorization`/`accessToken` 等字段）入库前会遮盖，规则与 stdout、系统日志一致；其余内容原样保存 |
| `[logs].detailed_max_bytes` | 单条请求/响应 JSON 上限（4KiB–1MiB，默认 64KiB） |
| `[logs].max_detail_bytes` | `model` + 详细正文合计 UTF-8 字节上限（默认 256MiB），超限先删最旧行 |
| `cursor_api_keys` | 可选的额外 Cursor key，逗号分隔（环境变量 `CURSOR_API_KEYS`）。与 `cursor_api_key` 一起组成 key 池：新建 agent 时在健康 key 间轮询；某个 key 返回上游认证错误或限流时进入冷却，本次请求自动切到下一个 key。已经向客户端输出内容后不再切换；待回传结果的工具轮次继续在原 agent（原 key）上执行 |
| `cursor_key_cooldown_ms` | 限流后的冷却时间（默认 **60000**，1 秒–24 小时），连续失败翻倍，最多 8 倍。认证失败冷却 15 分钟 |
| `cursor_key_strategy` | `round_robin`（默认）轮流使用各 key；`least_active` 把每个请求发给当前进行中请求最少的健康 key，持平时轮流。`GET /admin/api/cursor-keys` 返回每个 key 的 `active_requests`、`successes`、`failures`、`last_used_at` |
| `park_timeout_ms` | 工具轮次在内存里保留多久（默认 **300000**）。网关重启后，下一次工具结果按 HTTP transcript 续场 |
| `admin_request_timeout_ms` | 管理写请求时限（环境变量 `ADMIN_REQUEST_TIMEOUT_MS`），默认 **10000** ms，允许 1–300000；认证后限制 POST / PATCH / DELETE 的正文读取等异步等待，超时返回简单 JSON 错误 `504 request_timeout` 并关闭连接，参与退出清理。与生成请求时限独立 |
| `request_timeout_ms` | 每次 Chat/Responses 请求的总时限（环境变量 `REQUEST_TIMEOUT_MS`，默认 **300000** 毫秒，`0` 关闭），包括读取正文、模型预检和上游生成。超时返回 `504 request_timeout`；已经开始流式输出时通过错误事件结束。工具调用返回后停止本次计时，工具结果续轮重新计时 |
| `shutdown_timeout_ms` | 收到 SIGTERM/SIGINT 后等待在途请求正常结束的宽限（环境变量 `SHUTDOWN_TIMEOUT_MS`，默认 **10000** 毫秒）。停止接收新请求，到期取消剩余请求并清理会话；Compose 为进程预留 30 秒退出时间 |
| `max_live_sessions` | 内存中运行和等待工具结果的 Cursor 会话上限（默认 **256**）；正在创建的会话也计入上限 |
| `conversation_ttl_days` | 未使用的持久化 `conversation_id` 映射保留天数（默认 **30**） |
| `quota_reserve_recent_runs` | 按 Key 的 `quota_tokens` 预留同时覆盖该 Key 最近 N 次 run 的平均实际用量（环境变量 `QUOTA_RESERVE_RECENT_RUNS`，默认 **20**，`0` = 只用输入估算） |
| `ignore_sampling_params` | 丢弃 Chat Completions 不支持的采样参数（`temperature`、`top_p`、`top_k`、各类 penalty、`seed`、OpenRouter 的 `min_p` / `top_a` / `repetition_penalty`、`parallel_tool_calls: false`）而不返回 400（默认 **false**）。影响输出形态的字段（`stop`、`logit_bias`、`top_logprobs`）仍然 400 |
| `history_resume` | 客户端没有传 `conversation_id` 时（Chat Completions、没有 `previous_response_id` 的 Responses），如果请求里最后一条 user 之前的历史与某个已完成的回合一致，就续用上一个 Cursor agent，只发送新的 user 消息（环境变量 `HISTORY_RESUME`，默认 **false**，需主动开启）。默认关闭的原因：实测（gemini-2.5-flash）续用回合的未缓存输入并没有比重发完整 transcript 少（9527 对 9471），agent 自己的上下文反而变成额外的缓存读（8160），计费 Token 不降反升。如果更看重更短的上游 prompt 或 agent 连续性、而不是最少计费 Token，可以开启。匹配方式是对全部消息做 hash（assistant 文本去首尾空白）。每条记录最多用一次，而且只在 agent 的上下文恰好等于这段历史时有效：取用时即删除；该 agent 被其他方式使用（`previous_response_id` / `conversation_id` 续用、工具结果续轮、更新的回合）时也会删除，所以重新生成或分叉的回合会拿到新 agent 和完整 transcript。同一个 agent 同时只处理一个请求：hash 命中但 agent 正忙时改用新 agent；`conversation_id` / `previous_response_id` 请求遇到忙碌的 agent 返回 `409 conversation_busy`。隔离范围：客户端 Key，请求带 `user` 字段时再按 `user` 区分（一个 Key 服务多个终端用户的客户端应传 `user`）。禁用或删除 Key 时清除它的记录。内存保存 1 小时，每个客户端 Key 最多 10000 条（过期条目会被清理）。续用回合的配额估算按完整 transcript 计。被截断（`length` / stop 序列）或 JSON 模式的回复不记录。续用失败时，在输出任何内容之前回退到完整 transcript。`false`（默认）= 每轮都新建 agent 并发送完整 transcript。**回滚：** 设 `HISTORY_RESUME=false`（或换回旧版本）并重启即可；记录只在内存里（没有 schema 或数据变更），功能关闭时即清空 |
| `enforce_output_limits` | 由**网关**执行 `max_tokens` / `max_completion_tokens`（Chat）、`max_output_tokens`（Responses）以及 `stop`（环境变量 `ENFORCE_OUTPUT_LIMITS`，默认 **false** = 行为不变：Token 上限照收不管，`stop` 返回 400）。设为 `true`：网关截断可见文本并取消 Cursor run；结束原因为 `length`（Responses 为 `status: "incomplete"`）或 `stop`。Token 按每 4 个字符 1 个**估算**；截断时思考文本不计入；最多 4 个 stop，每个最长 256 字符。上限、流式和 JSON 格式按每个 HTTP 请求生效（工具结果续轮用续轮自己的设置）。流式时 stop 序列本身不会发给客户端（末尾几个字符会暂缓，直到确定不会组成 stop）。usage 仍是 Cursor 实际计费的用量 |
| `allow_max_mode` | 是否允许 Cursor **max mode**（环境变量 `ALLOW_MAX_MODE`，默认 **true**）。当前锁定的 `@cursor/sdk` 会在「与解析出的参数匹配的目录变体全部是 max-only」时自动开启 max mode，按更高费率计费。网关以模型的默认变体为基础参数，所以默认变体是 max-only 的模型（例如默认长上下文）只写模型名就会走 max。设为 `false`：网关会换成保留客户端显式选择的最接近的非 max 变体；只有 max 变体能满足的请求（max-only 模型，或 `variant`/`params` 指向 max 变体）返回 `403 max_mode_not_allowed`。各条路由的 effort 一律按软提示处理，包括 Chat `reasoning_effort`、Responses `reasoning.effort` / 顶层 `reasoning_effort`。所要求的档位需要 max 变体时，降到最高的非 max 档位（没有则用默认变体），不返回 403，并写日志（`max mode disallowed: using non-max variant`，字段 `softened_effort`、`effort`）。只在 max 变体里出现的参数值（如 `context=1m`）即使和其他参数混用也不会被发出。`Agent.create` / `resume` / `send` 之后，网关还会检查 SDK 实际解析出的模型（`agent.model` / `run.model`，可能和网关目录不一致）；如果是 max mode，就释放 agent 或取消 run，返回 `403`（流式时是一条 SSE 错误帧，并且在检查通过前不会输出任何模型文本）。受 SDK 限制，`send` 阶段的检查只能在 SDK 已经发出 run 之后进行：网关会取消它，但请求可能已经到达 Cursor 并按已用量计费；这类请求在日志里记 `max_mode = 1`，也不会重放。`params` 的取值不区分大小写（也可以用取值的显示名）匹配，并且总是按目录里的规范值转发，所以 `1M`、`1m context` 都按 `1m` 处理。每条请求日志记录的是**实际**的 `max_mode` |
| `quota_cache_read_weight` | 缓存读 Token 计入按 Key `quota_tokens` 的权重（0–1，环境变量 `QUOTA_CACHE_READ_WEIGHT`，默认 **1.0**）；Key 自己的 `quota_cache_read_weight` 优先 |
| `sse_keepalive_ms` | 空闲流式响应发送 `: keepalive` 注释的间隔（默认 **15000**；`0` 关闭） |
| `cors_allow_origins` | 浏览器跨域来源，默认 `"*"`；用逗号分隔精确来源（如 `"https://app.example.com,http://localhost:5173"`），空字符串关闭 CORS。环境变量 `CORS_ALLOW_ORIGINS` 可覆盖，包括空值 |
| `auth_failure_limit` | 每个客户端地址在任意 60 秒滑动窗口内允许的认证失败次数（默认 **20**，最大 1000；`0` 关闭）。管理密钥和客户端 Key 分开计数。**管理端：**达到上限后，该地址的所有管理请求（包括正确密钥）都返回 `429` 和 `Retry-After`，直到窗口内的失败数回落。**客户端 Key：**正确的 Key 永远不会被限流，只有继续使用错误 Key 的请求会返回 `429` + `Retry-After`（代替 `401`）。不带任何 Key 的请求不计数。IPv6 按 /64 合并计数 |
| `rate_limit_per_key` | 每个客户端 Key 在 60 秒滚动窗口内允许的 Chat Completions 和 Responses 生成请求数（环境变量 `RATE_LIMIT_PER_KEY`，默认 **0**，非负整数；`0` 关闭）。模型读取、Response 查询、health 和管理接口不消耗额度。解析/认证失败、模型预检失败及 quota/concurrency 准入拒绝也不消耗额度；请求一旦准入即占用一次，之后上游或模型解析失败也不退回；流式请求只计一次，每次工具结果续轮按新请求计数 |
| `trusted_proxies` | 反向代理的 IP 或 CIDR，逗号分隔，例如 `"127.0.0.1, 172.18.0.0/16"`（环境变量 `TRUSTED_PROXIES`）。默认为空：TCP 对端地址即客户端地址，忽略 `X-Forwarded-For`。对端在列表中时，取 `X-Forwarded-For` 从右往左第一个不在列表中的地址。在反代后面却不配置此项时，所有客户端在 `auth_failure_limit` 中共用代理地址。只填写会覆盖或追加 `X-Forwarded-For` 的代理（nginx `proxy_add_x_forwarded_for`、Caddy 默认行为） |

会话在重启后仍绑定创建它的 Cursor Key，SQLite 仅保存指纹。移除所属 Key 后，增量续接会明确报错；发送完整历史可重放。旧映射没有归属信息时，多 Key 模式需要完整历史。

请求超时或服务退出会尝试取消上游，但不能据此判断没有产生费用。SDK 尚未返回的创建或发送仍占用容量，迟到结果会被清理；已经调用发送但派发状态未知时保留保守配额。若增大退出宽限，也应同步增大容器的 `stop_grace_period`，为清理留出时间。

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
| `GET` | `/v1/models`、`/v1/models/{id}` | 模型列表 |
| `GET` | `/v1/responses/{id}` | 取回已完成的 Response（内存保存，按客户端 Key 隔离，1 小时，每个 Key 最多最近 100 条 / 8 MiB、总共 1000 条 / 32 MiB UTF-8 JSON 载荷；条数满时淘汰条目最多的 Key 的最旧条目，字节满时淘汰载荷最大的 Key 的最旧条目；每次读写先清理全局过期条目；单条超过 8 MiB 时正常返回但不缓存，后续读取为 404；`store: false` 不保存；重启丢失。字节上限不代表整个进程内存上限） |

支持流式（`stream: true`）、视觉（`image_url`，以及 OpenCode 的 `image` / 图片 `file` 部件）、思考块（`delta.reasoning_content`，同时以 `delta.reasoning` / `message.reasoning` 再给一份，兼容 OpenRouter 风格客户端）、Cursor 参数（`params`、`variant`、`reasoning_effort` 等）。`variant` 匹配唯一的目录显示名；当 Cursor 把所有 variant 都起成同一个显示名时，改为匹配 effort/reasoning/fast 的值（OpenCode `--variant high` 在 `@ai-sdk/openai-compatible` 上不会发出该字段；请在请求体里发 `variant` 或 `reasoning_effort`）。支持 OpenAI 工具调用（`tools` / `tool_calls` / `role: tool`），供 OpenCode 等客户端在本地执行工具。Cursor 的 shell/文件工具保持关闭；仅在有客户端工具时打开 MCP，用来把这些工具暴露给模型。不支持音频。`temperature` / `top_p` / `seed` 会 400；`max_tokens` 仍接收。`reasoning_effort` 按尽力而为处理：精确匹配模型取值，否则取最接近档位；模型没有 effort 参数时忽略（布尔型思考开关：`none`/`minimal` 映射为关）。即使允许 max mode，「最接近档位」和思考开关也不会选只在 max 变体里出现的取值；只有精确的显式取值（例如模型列出 `max` 时传 `reasoning_effort: "max"`）才可能走 max mode。

Chat Completions 接受 OpenRouter 风格的 `reasoning: { effort, max_tokens, enabled, exclude }`，作为软提示（不会 400）：`effort` 取最接近档位，`max_tokens` 按预算选档（<4096 low，<16384 medium，否则 high），`enabled: false` 取最低档，`exclude: true` 不返回思考文本。顶层 `reasoning_effort` 优先。`response_format` 的 `json_object` / `json_schema`（以及 Responses 的 `text.format`）是**尽力而为**：Cursor 没有约束解码，网关会在发给上游的 prompt 末尾附加 JSON 指令（含 schema），非流式回复会去掉外层 ```` ```json ```` 代码块；仍不是合法 JSON 时原样返回并写日志（`json output requested but the reply is not valid JSON`）。不校验 schema。`max_tokens` / `stop` 见 `enforce_output_limits`。

Usage 按 OpenAI 语义：`prompt_tokens` 包含缓存 Token（`prompt_tokens_details.cached_tokens` = 缓存读；缓存写另外以 `cache_write_tokens` 返回），模型上报时带 `completion_tokens_details.reasoning_tokens`，`total_tokens = prompt_tokens + completion_tokens`。请求日志的 `input_tokens` 也按此口径。升级时会把旧行一次性改写为「input + 缓存读 + 缓存写」（以 `PRAGMA user_version` < 11 为条件），所以管理台的 Token 汇总不会混用两种口径。对自行把 `cached_tokens` 加到 `prompt_tokens` 上、或按 `prompt_tokens` 对账的客户端来说，这是**破坏性变更**。`conversation_id`（或 `metadata.conversation_id`）按客户端 Key 续同一个 Cursor Agent；ID 最多 512 个 UTF-8 字节，每个客户端 Key 保留最近 1000 条映射。工具停车超时为 `park_timeout_ms`（默认 300000）；网关重启后，工具结果按 HTTP transcript 续场。

Cursor SDK 每轮接收的是单个 prompt，并不原生接收 OpenAI 角色消息。本项目会把 `system` / `developer` / `user` 角色序列化进 transcript 文本；因此应用传入的 `system` 或 `developer` 消息只能作为上下文，不能充当抵御恶意用户内容的硬安全边界。

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

浏览器访问 `/admin/`：总览（含近 7 天调用曲线、请求时限、退出宽限期、进程内存、Response 缓存载荷和未完成 SDK 操作）、客户端 Key（创建 / 停用 / 恢复 / 删除 / 策略与配额）、请求日志、系统日志。

总览展示运行中的版本、提交、数据库 schema 和当前生效配置（只读）。请求日志为常见错误码提供中文说明并保留原始码，显示 Max 模式的 Max、普通、未记录三种状态；未记录不能用于判断是否请求过上游或产生费用。

客户端 Key 列表显示剩余请求、剩余 Token、重置时间和配额时区；策略编辑会校验输入，保存或重置期间防止重复操作，失败保留输入。

请求日志独立保存上游报告的 `raw_cost_cents`、`charged_cents` 和 `cost_scope`，无需开启详细正文日志。`cost_scope: "agent_total"` 表示 **Agent 累计费用快照**，单位为浮点分（cents）；上游账单事件可能延迟，快照可能不完整，不能相加作为各次请求的费用。未知费用及升级前的记录保留 `null`，显式报告的零值保留 `0`。费用元数据与请求日志遵循相同保留策略，不是永久账单账本，也不提供金额硬限额。

管理 API：`/admin/api/*`，用同一把 `admin_access_key`（`Authorization: Bearer` 或 `X-Management-Key`）。`DELETE /admin/api/keys/{id}` 删除客户端 Key，历史请求日志保留。`GET /admin/api/system-logs` 列出写入 SQLite 的网关 stdout/stderr 事件。`GET /admin/api/cursor-keys` 查看上游 key 池状态（sha256 指纹、`healthy` / `cooling_down`、失败计数；不返回 key 本身）。概览接口包含 `cursor_keys: {total, healthy}`。

### 按 Key 的模型策略与配额

每把客户端 Key 都可以单独设置策略，所有字段都可选。已有的 Key（以及创建时没带这些字段的新 Key）默认不受限制，升级后什么都不会变，直到你主动设置。

| 字段 | 含义 |
| --- | --- |
| `allowed_models` | `null` = 不限模型；否则是精确模型 id 或 `*` 通配（不区分大小写）的列表，例如 `["gemini-*", "composer-2.5"]`。在 `model_aliases` 映射之后检查，并对解析出的目录 id 再检查一次，所以别名无法绕过白名单。通配只匹配目录 id，目录别名必须精确列出。`GET /v1/models` 只列出允许的模型，`GET /v1/models/{id}` 对其余模型返回 404。不允许的模型返回 `403 model_not_allowed`（`param: "model"`）。 |
| `allow_max_mode` | `null` = 继承网关的 `allow_max_mode`；`false` 对该 Key 关闭 max mode。网关设置是**硬上限**：实际生效 = 网关 **AND** Key，所以网关 `allow_max_mode = false` 时 Key 设 `true` 也不能打开 max mode。管理接口返回 `effective_allow_max_mode`；Key 设为 `true` 但被网关上限压住时，还会带一条 `warnings`。管理台显示实际生效的状态。回退 / `403 max_mode_not_allowed` 行为与全局一致（包括对 SDK 实际解析模型的检查）。 |
| `quota_requests` | 每周期最多请求数。在上游 run 之前原子预扣（并发请求不会超额），run 没有启动则退还。 |
| `quota_tokens` | 每周期 Token 额度，属于**软上限**。准入时每个请求原子地**预留**以下两者中较大的一个：输入估算（字符数 / 4，再加 1024 个输出 Token），或该 Key 最近 `quota_reserve_recent_runs` 次 run 的平均实际用量（默认 20 次，按进程保存在内存里）。只有「已用 + 已预留」低于额度才放行；结束时用实际计费替换预留（见下文「Token 计量」）。所以并发请求不会一起冲过快用完的额度，例如额度 100k 时，100 个约 20k Token 的并发 run 大约只放行 5 个。超出上界是「额度 − 1 + 已放行请求的 Σ(实际用量 − 预留)⁺」：Key 有历史后这一项很小；冷启动时所有预留都还只是输入估算，这一项可能较大。 |
| `quota_period` | `total`（默认，永不重置）、`daily`、`monthly`。 |
| `quota_tz` | 计算周期边界用的 IANA 时区（默认 `UTC`），例如 `Asia/Singapore`。保存规范名（`asia/singapore` → `Asia/Singapore`），拒绝 `+08:00` 这类 UTC 偏移。已保存但当前运行时不认识的时区回退为 UTC 并写日志。在午夜切换夏令时的时区（Havana、Azores 等），一天从该日第一个存在的本地时刻开始。 |
| `max_concurrent` | 该 Key 同时进行中的最大请求数（按网关进程计，多实例要乘以实例数）。因客户端工具调用而挂起的 Agent 也占一个槽，直到工具结果送回（续轮请求沿用这个槽）或挂起超时。 |
| `quota_cache_read_weight` | `null` = 继承网关 `quota_cache_read_weight`（环境变量 `QUOTA_CACHE_READ_WEIGHT`，默认 `1.0`）。0 到 1 的数字：每个缓存读 Token 在 `quota_tokens` 中按多少计（例如 `0.1` 约等于缓存读的价格比例）。 |

超出配额返回 `429 insufficient_quota`，带 `Retry-After`（距下个周期的秒数；`total` 不带）。超出并发上限返回 `429 concurrency_limit_exceeded`，`Retry-After: 1`。模型检查在配额之前，所以不允许的模型得到 403/404 而不是 429，也不扣次数。

总览的上游模型目录检查最多等待 1.5 秒，超时仍返回本地运行状态，并标记 `upstream_error_code: "upstream_timeout"`。每个上游 Key 池最多保留一个未结束的总览检查；网页管理请求超过 15 秒会提示超时，写操作不会自动重试。 同一资源的读取只展示最新结果；后台轮询未完成时跳过下一轮，读取失败保留已有内容并提示重试。管理写接口另有默认 10 秒的服务端时限；超时或断连后，未读完正文的操作不会迟到入库。时限不能抢占已经开始的同步 SQLite 操作或锁等待，也不会回滚已提交的变更；这不是数据库执行的硬截止时间，结果不确定时先刷新核对。内存 RSS 包含堆和其他进程内存，缓存字节只统计序列化载荷；ArrayBuffer 属于 external 内存，不能再次相加。

管理 API：`POST /admin/api/keys` 接受以上字段；`PATCH /admin/api/keys/{id}` 修改任意字段（以及 `name`；没传的字段不变，传 `null` 表示取消限制）；`GET /admin/api/keys/{id}/usage` 返回本周期用量（`requests`、`tokens`、`remaining_*`、`in_flight`、`resets_at`）和最近几个周期；`POST /admin/api/keys/{id}/usage/reset` 把本周期清零。`GET /admin/api/keys` 会带上每把 Key 的策略和 `usage_current`。管理台在 **客户端 Key → 策略** 中编辑。

Token 计量的限制：
- 每个请求按以下顺序计费：①SDK 每次 run 的用量（`run.wait().usage`）；run 启动后被中断或失败时，取这个用量和②中估算值的较大者，所以取消后上游报的部分用量或 0 不会导致少计；②没有用量时按保守估算计：发往上游的输入，加上已输出的文本、思考和工具调用参数，约每 4 个字符 1 个 Token（适用于中断后没有用量、只有累计用量的情况）；③什么都拿不到（run 启动后失败）时，准入时的预留就作为计费。Agent 累计总量永远不计入，否则续会话会重复计算。用量来源可插拔，便于以后接入官方的按 run 用量接口。
- 以客户端工具调用结束的轮次（挂起的 run）在返回响应时先按估算计费，所以放弃的工具轮也不会免费。工具结果送回、run 完成后，再补计「实际用量 − 已计部分」（不会是负数）。
- run 没有启动的请求（校验错误、send 失败）会退还请求次数和预留。
- 数据库：`PRAGMA user_version` 记录 schema 版本（12）。回滚到 v10 之前的版本会忽略策略列，也就是**所有客户端 Key 都变成不受限**；再次升级后策略恢复。
  - 回滚期间产生的用量，再次升级后不会补记到 `api_key_usage`。
  - 在旧版本上删除 Key，会留下它的 `api_key_usage` 行（孤儿行，无害，不计入任何额度）。
  - 从 schema 11 之前升级时，会一次性把历史 `request_logs.input_tokens` 加上缓存读写，并记录当前 schema 版本 12。升级前使用 SQLite 在线备份，或停服后备份数据目录；回滚代码不会撤销计数转换。
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

统计与日志裁剪使用数据库索引；旧库升级首次启动会建立索引，需预留启动时间与磁盘空间。性能口径和限制见[SQLite 优化验证](docs/sqlite-optimization-20261021.md)。

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

快速单元测试用 `npm run test:unit`；`npm test` 还会运行回环 HTTP 鉴权冒烟测试。测试不会访问网络：测试启动的网关都用假 Cursor SDK（`tests/fixtures/fake-cursor-sdk.mjs`）；`scripts/run-tests.mjs` 通过 `NODE_OPTIONS` 预加载守卫 `tests/fixtures/no-network.mjs`（子进程同样生效），拦截并记录非回环的 TCP/TLS 连接（`net`、`tls`、`http`、`https`、`http2`、`fetch`）、DNS 解析和查询以及 UDP 发送；`localhost` 只有解析结果是回环地址时才放行。只要记录到一次尝试，即使代码吞掉了错误，整个测试也判失败。测试创建的临时目录都在本次运行专用的 `TMPDIR` 里，跑完删除。`CURSOR_API_TEST_ALLOW_NETWORK=1` 可关闭守卫（目前没有测试需要）。JS 守卫看不到未继承其 `NODE_OPTIONS` 的子进程、worker 线程和原生二进制，所以 Linux 上 `npm run test:offline` 会在空网络命名空间（`unshare -rn`）里、去掉 `CURSOR_*` 及名字像 key/token/secret 的变量后运行；CI 跑的就是 `test:offline`。

`npm run test:tmpdirs` 检查是否残留 `cursor-api-*` 临时目录。

测试还使用官方 OpenAI Node SDK 验证网关的 Chat/Responses、流式、工具往返、Response 读取与错误解析；测试套件中的 Cursor 上游为模拟实现。

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

## 数据备份与恢复

数据库使用 WAL。服务运行时不要只复制 `cursor-api.sqlite`；用 SQLite 在线备份或 `VACUUM INTO` 创建一致快照，目标文件必须不存在或为空，并确认命令成功。`VACUUM INTO` 期间断电或中断可能留下不完整文件，不能把它当作有效备份。备份文件限制为仅拥有者可读写，并放在受保护的位置。

恢复时先停服，将现有数据目录完整保留为恢复点；在新的数据目录放入备份，命名为 `cursor-api.sqlite`，不要混入旧的 `-wal` / `-shm` 文件。配置和数据库需要配套恢复，特别是原有 `api_key_pepper`，否则已有客户端 Key 无法认证；上游 Key 仍需原账号凭据。配置含密钥，应单独安全备份。先对副本运行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`，确认完整性、schema、Key 策略和配额，再用当前版本打开并核对 `/health`，随后恢复流量。失败时停服并切回完整恢复点，不覆盖唯一备份。

Response 缓存和工具停车状态不属于数据库备份，重启后丢失；会话映射恢复也不保证上游 Agent 仍可续接。
