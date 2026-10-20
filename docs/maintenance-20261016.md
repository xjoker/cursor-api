# 维护评估：2026-10-20

版本 `20261020.1` 整合合作开发者的 PR #15–#27，并保留 main 已合并的认证、依赖和监听地址改动。原作者提交历史随整合保留。

## PR 核对结果

| PR | 当前行为 |
| --- | --- |
| [#15](https://github.com/xjoker/cursor-api/pull/15)、[#23](https://github.com/xjoker/cursor-api/pull/23) | Anthropic Messages、Claude Code 工具往返、模型别名；`count_tokens` 默认关闭，显式配置 `estimate` 可返回带估算标志的本地计数 |
| [#16](https://github.com/xjoker/cursor-api/pull/16) | PR CI、Node 22.13 / 22 / 24 测试矩阵、amd64 容器健康检查 |
| [#17](https://github.com/xjoker/cursor-api/pull/17)、[#25](https://github.com/xjoker/cursor-api/pull/25)、[#26](https://github.com/xjoker/cursor-api/pull/26) | Cursor Key 池、故障冷却、轮询及 least_active、管理台指纹和请求计数 |
| [#18](https://github.com/xjoker/cursor-api/pull/18) | SSE 立即发送响应头、15 秒心跳、断连清理 |
| [#19](https://github.com/xjoker/cursor-api/pull/19) | 上游认证、限流、忙碌、不可用和超时分别映射；保留结构化诊断 |
| [#20](https://github.com/xjoker/cursor-api/pull/20) | 可选忽略不支持的 Chat 采样参数，默认严格校验 |
| [#21](https://github.com/xjoker/cursor-api/pull/21) | 无状态工具结果续接停车会话；工具回合 response ID 持久化供后续恢复 |
| [#22](https://github.com/xjoker/cursor-api/pull/22) | Responses reasoning hint 就近映射，显式严格参数继续校验 |
| [#24](https://github.com/xjoker/cursor-api/pull/24) | 会话并发创建前占位；默认 256 个运行或停车会话，映射 TTL 30 天 |
| [#27](https://github.com/xjoker/cursor-api/pull/27) | 递归遮盖日志对象、数组、字符串中的凭据，保留 token 数和非敏感 ID |

恢复 Cursor agent 使用原账号 Key；数据库只记录 Key 指纹。模型目录验证与执行绑定同一 Key。工具停车后回传属于新的在途请求，继续计入该 Key 的负载。已经向客户端发送内容后不会切换账号重试。

## Issue 核对结果

- [#29](https://github.com/xjoker/cursor-api/issues/29)：SDK 无精确 tokenizer。默认 404，估算需显式开启；误差可能影响客户端压缩时机，不能作为真实用量。
- [#30](https://github.com/xjoker/cursor-api/issues/30)：认证失败限制和会话上限已实现；业务请求速率由反向代理控制，内置按客户端 Key 的业务配额仍未实现。可使用以下 nginx 配置，阈值按实际负载调整：

  ```nginx
  # http context
  limit_req_zone $binary_remote_addr zone=cursor_api:10m rate=5r/s;
  # server context
  location /v1/ {
      limit_req zone=cursor_api burst=20 nodelay;
      proxy_pass http://127.0.0.1:8787;
      proxy_buffering off;
      proxy_read_timeout 300s;
  }
  ```

  未对 nginx 配置做运行验证。依据：[nginx limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)、[proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。
- [#31](https://github.com/xjoker/cursor-api/issues/31)：`cors_allow_origins` / `CORS_ALLOW_ORIGINS` 支持精确白名单、默认 `*` 和空值关闭；预检及错误响应使用同一策略。
- [#32](https://github.com/xjoker/cursor-api/issues/32)：真实 Cursor 上游验证仍未完成。模拟 SDK 不证明真实费用、模型行为、多账号权限或反向代理长流表现。

## 运行与数据边界

Node 最低版本 22.13；官方 Docker 镜像使用 Node 22、`linux/amd64`，宿主数据目录挂载到 `/app/data`。依赖版本以 `package.json` / `package-lock.json` 为准（`@cursor/sdk`、TypeScript、Node 类型均精确锁定）；锁文件不再需要旧 `undici` 覆盖。

无 Docker 时默认仅监听 `127.0.0.1`；官方镜像通过 `GATEWAY_DEFAULT_HOST=0.0.0.0` 监听容器网络，挂载 TOML 的 `host` 优先级更高。环境变量 `GATEWAY_HOST` 覆盖 TOML 时输出提示。

认证失败按地址滑动窗口计数，管理和客户端认证分开。有效客户端 Key 不被错误 Key 的失败数阻断；管理认证达到上限后拒绝该地址全部管理请求。默认忽略 `X-Forwarded-For`，只有 `trusted_proxies` 指定的代理可提供客户端地址。

## 验证边界

- `npm run typecheck`、`git diff --check` 通过；全量 `npm test`：131 项通过，0 失败。
- Key 池的旧 SQLite 迁移、三协议模型选择、增量会话归属、停车续接计数先复现 4 项失败；修复后通过。未知模型流式请求先复现错误的 200，修复后各协议均在 SSE 前返回 404。
- `npm audit`：0 个已知漏洞。
- amd64 镜像无缓存构建通过；Node 22 容器实际启动后，Docker HEALTHCHECK 为 healthy，`/health` 版本为 `20261020.1`、schema 为 8，commit 与构建注入值一致；未认证 API 返回 401，管理页防嵌入头生效。
- 同一镜像挂载模拟 SDK 后，Chat、Responses、Messages 核心请求均返回 200，默认 token 估算关闭返回 404。临时容器已清理。

远端 Node 矩阵结果以整合 PR 的 CI 检查为准。模型行为使用模拟 SDK，数据库测试使用真实临时 SQLite。真实 Cursor 上游、实际多账号权限及生产部署状态未验证。

非法工具结果在 SSE 建立前返回 400；该回归先复现 200，修复后包括三协议工具往返的 23 项定向测试通过。
