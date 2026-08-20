# cursor-api

基于 Cursor 官方 SDK 的极简 **OpenAI 兼容 Chat Completions 网关**。把 Cursor 模型暴露给标准 OpenAI 客户端，支持签发客户端 Key，并在内置管理台查看请求日志。

**English:** [`README.md`](./README.md)

**版本：** [`VERSION`](./VERSION) · **变更记录：** [`CHANGELOG.md`](./CHANGELOG.md)

---

## 快速开始（Docker Compose）

从零到 `http://127.0.0.1:8787` 可用，按下面四步走。

### 1. 前置条件

- Docker Compose
- **Cursor User API Key**（[Cursor 控制台](https://cursor.com/settings)）
- 仅从源码运行时需 Node **22.13+**（见 [本地开发](#本地开发)）

### 2. 配置

所有项写在同一个文件 `data/config/gateway.toml`（**不要进 git**）。

```bash
cp data/config/gateway.toml.example data/config/gateway.toml
chmod 600 data/config/gateway.toml
```

编辑 `data/config/gateway.toml`：

```toml
host = "0.0.0.0"
port = 8787

cursor_api_key = "你的-cursor-user-api-key"
admin_access_key = "随机长串-管理密钥"
api_key_pepper = "随机长串-HMAC-盐"
```

| 键 | 用途 |
|----|------|
| `cursor_api_key` | 上游 Cursor 账号 Key（单账号） |
| `admin_access_key` | 管理台与 `/admin/api/*` 认证 |
| `api_key_pepper` | 客户端 Key 摘要的 HMAC 盐 |
| `host`, `port` | 监听地址（可选，见下方默认） |

> 不要提交 `gateway.toml`；模板见 `gateway.toml.example`。  
> **Docker：** 首次启动若缺少 `gateway.toml`，会在挂载的 `data/` 卷里自动创建空文件，填好密钥后重启即可。

### 3. 启动网关

```bash
# 先确保 8787 端口未被占用
docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
docker compose up -d
curl -s http://127.0.0.1:8787/health
```

应返回含 `status`、`version`、`git_commit`、`schema_version` 的 JSON。

**Linux bind mount：** 若容器读不了 `chmod 600` 的 `gateway.toml`，对齐宿主机用户：

```bash
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

可选环境变量覆盖见 [`.env.example`](./.env.example)。

### 4. 创建客户端 Key 并接入

1. 浏览器打开 **http://127.0.0.1:8787/admin/**，填入 `admin_access_key`。
2. 进入 **Client Keys**，创建 Key（前缀 `cgk_`）。只显示一次，库中仅存摘要。
3. 客户端配置：

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<你的 cgk_ 客户端 Key>
```

**冒烟测试：**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cgk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Reply with PONG only."}]}'
```

浏览器访问 `/` 会跳到 `/admin/`；`curl /` 返回 JSON 接口说明。

---

## 客户端接入

### 认证

任选一种请求头：

```http
Authorization: Bearer cgk_...
X-Api-Key: cgk_...
```

（部分 Claude 系客户端习惯 `X-Api-Key`。）

### 支持的 OpenAI 接口

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/v1/chat/completions` | 客户端 Key | 对话（流式/非流式） |
| `GET` | `/v1/models` | 客户端 Key | 模型列表 |
| `GET` | `/v1/models/{id}` | 客户端 Key | 单个模型 |
| `OPTIONS` | `/v1/*` | — | CORS 预检 |

**请求体要点**

- **必填：** `model`、非空 `messages`
- **流式：** `stream: true`（必须是布尔值）
- **视觉：** `image_url`，支持 `data:` 或 `http(s):`
- **会转发：** `params`、`variant`、`reasoning_effort`、`verbosity`、`fast`、`optimize_for`
- **接受但不转发：** `temperature`、`top_p` 等常见采样字段
- **不支持：** 工具调用、音频、`n > 1`、非 text 的 `response_format`

响应可能包含 SDK 返回的 `cursor.cost` 与 usage。

### 示例：OpenAI Python SDK

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

### 示例：环境变量

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=cgk_YOUR_KEY
```

---

## 管理台

单页控制台：`/admin/`（别名 `/management.html`）。

| 区域 | 功能 |
|------|------|
| **总览** | 网关状态、Base URL 提示、近期活动 |
| **Client Keys** | 创建、启用/禁用客户端 Key |
| **请求日志** | 按时间范围、状态、模型筛选；分页 |

管理 REST API：`/admin/api/*`

```http
Authorization: Bearer <admin_access_key>
X-Management-Key: <admin_access_key>
```

`GET /v1/usage` 与 `x-ratelimit-*`（若有）表示**网关给客户端 Key 的配额**，不是 Cursor 账号余额。

---

## 配置

**优先级（高覆盖低）：** 环境变量 → `.env` → `data/config/gateway.toml` → 默认值

| 文件 | 内容 |
|------|------|
| `data/config/gateway.toml` | 密钥 + `host`、`port`、可选 `data_dir`、`cursor_workspace` |

**默认监听**

| 场景 | 地址 | 端口 |
|------|------|------|
| `npm run dev` | `127.0.0.1` | `8787` |
| Docker（`NODE_ENV=production`） | `0.0.0.0` | `8787` |

SQLite 与工作区在 `data/` 下（Compose 卷挂载）。日常不要把密钥写进镜像或 Compose `environment`。

可选环境变量见 [`.env.example`](./.env.example)。

---

## 本地开发

```bash
npm ci
cp data/config/gateway.toml.example data/config/gateway.toml
chmod 600 data/config/gateway.toml
npm run dev
npm run build && npm start
npm test
npm run typecheck
```

| 检查 | 路径 |
|------|------|
| 健康检查 | `GET /health` |
| 发现接口 | `GET /`（JSON）或浏览器 → `/admin/` |

---

## 运维

| 端点 | 说明 |
|------|------|
| `GET /health` | 存活、`version`、`git_commit`、`schema_version` |
| `GET /` | JSON 接口地图 |

**Docker：** 多阶段构建，`linux/amd64`，`TZ=UTC`。镜像 tag 用 [`VERSION`](./VERSION)；构建时传 `GIT_COMMIT`。

**升级：** 阅读 [`CHANGELOG.md`](./CHANGELOG.md)，必要时备份 `data/`，重建后核对 `/health`。

---

## 架构

```text
OpenAI 客户端  --Bearer cgk_*-->  cursor-api  --Cursor SDK-->  Cursor 云端
                                      |
                                      +-- SQLite（Key、请求日志）
                                      +-- 管理台 (/admin/)
```

单 Cursor 上游账号；MVP 不做多账号路由。

---

## 许可证

MIT — 见 [`package.json`](./package.json)。
