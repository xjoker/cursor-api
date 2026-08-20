# cursor-api

**把 Cursor 模型暴露成 OpenAI 兼容接口。** 任意 OpenAI 客户端指向 `/v1`；在管理台签发客户端 Key、查看请求日志。

**English:** [`README.md`](./README.md) · **变更记录：** [`CHANGELOG.md`](./CHANGELOG.md)

**你需要：** [Docker Compose](https://docs.docker.com/compose/) 和 [Cursor User API Key](https://cursor.com/settings)。

## 四步部署

1. **起容器** — `docker compose up -d`
2. **自动生成配置** — 首次运行会创建 `data/config/gateway.toml`（空模板）
3. **改配置** — 填入三把密钥（见下）
4. **重启** — `docker compose restart` → 网关监听 `http://127.0.0.1:8787`

不用手动复制 example 文件。密钥不进镜像、不进 git。

---

## 1. 起容器

```bash
cd cursor-api   # 先 clone 本仓库
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)   # Linux：首次启动前就要设
docker compose up -d
```

第一次启动可能因密钥未填而退出，这是正常的；`data/` 卷里仍会生成 `gateway.toml`。

**Linux：** 务必在**第一次** `docker compose up -d` 之前执行 `GATEWAY_UID` / `GATEWAY_GID`，这样自动生成的配置文件归当前用户所有。若已经用 UID 1000 起过一次，先改归属再重启：

```bash
sudo chown "$(id -u):$(id -g)" data/config/gateway.toml
export GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g)
docker compose up -d
```

---

## 2. 编辑 `data/config/gateway.toml`

改容器自动生成的文件（源码运行时也可从 [`gateway.toml.example`](./data/config/gateway.toml.example) 复制）。

```toml
host = "0.0.0.0"
port = 8787

cursor_api_key = "你的-cursor-user-api-key"
admin_access_key = "随机长串-管理密钥"
api_key_pepper = "随机长串-HMAC-盐"
```

| 键 | 含义 |
|----|------|
| `cursor_api_key` | Cursor 账号 Key（上游） |
| `admin_access_key` | 管理台登录密钥 |
| `api_key_pepper` | 客户端 Key 哈希用的随机串 |

```bash
chmod 600 data/config/gateway.toml
```

---

## 3. 重启

```bash
docker compose restart
curl -s http://127.0.0.1:8787/health
```

应看到 `"status":"ok"`。

---

## 4. 接入客户端

1. 浏览器打开 **http://127.0.0.1:8787/admin/**，填入 `admin_access_key`。
2. **Client Keys** → 创建 Key（`cgk_` 开头），只显示一次。
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

| 方法 | 路径 |
|------|------|
| `POST` | `/v1/chat/completions` |
| `GET` | `/v1/models`、`/v1/models/{id}` |

支持流式（`stream: true`）、视觉（`image_url`）、Cursor 参数（`params`、`variant` 等）。不支持工具调用和音频。

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

浏览器访问 `/admin/`：总览、客户端 Key、请求日志（时间筛选、翻页）。

管理 API：`/admin/api/*`，用同一把 `admin_access_key`（`Authorization: Bearer` 或 `X-Management-Key`）。

---

## 配置说明

唯一配置文件：`data/config/gateway.toml`。可选覆盖见 [`.env.example`](./.env.example)。

**优先级：** 环境变量 → `.env` → TOML → 默认值。

SQLite 与工作区在 `./data`，重启不丢。

---

## 本地开发

需 Node **22.13+**。准备好 `data/config/gateway.toml` 后：

```bash
npm ci && npm run dev
```

---

## 健康检查

| 端点 | 用途 |
|------|------|
| `GET /health` | 版本与存活 |
| `GET /` | JSON 接口说明（curl）或跳转管理台（浏览器） |

---

## 许可证

MIT — 见 [`package.json`](./package.json)。
