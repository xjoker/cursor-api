# 维护评估：2026-10-20

版本 `20261020.2` 在前一版基础上整合 PR #38、#40–#46；原作者提交历史随整合保留。

## 新功能与接手范围

| PR | 当前行为 |
| --- | --- |
| #38 | SDK 1.0.38、max-mode 策略与实际 SDK 解析结果检查 |
| #40 | 按客户端 Key 的模型白名单、请求/Token 配额、并发限制与管理台策略编辑 |
| #41 | OpenAI usage 含缓存读写、软推理档位、缓存读配额权重；schema 11 一次性迁移旧计数 |
| #42 | reasoning 双字段、可选输出限制、尽力而为 JSON 格式、按 Key 隔离的 Response 内存读取 |
| #43 | 默认假 SDK、出网守卫、Linux CI 空网络命名空间 |
| #44 | 按历史复用 agent，默认关闭；按 Key/user 隔离、一次性记录和忙碌锁 |
| #45 | 请求/响应日志入库前脱敏，包括模型名、字段名及上游错误 |
| #46 | 测试临时目录回收与残留检查；整合后覆盖新增功能的测试目录，目录检查同样启用出网守卫 |

输出长度限制与历史复用均默认关闭；max mode 沿用默认允许，关闭全局开关后 Key 不能放宽。Token 配额属于软上限，冷启动及在途请求仍可能超额；不支持费用配额。JSON 模式不保证合法 JSON 或 schema 合规。Response 与历史复用记录重启后丢失。

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
- [#30](https://github.com/xjoker/cursor-api/issues/30)：认证失败限制和会话上限已实现；已增加按客户端 Key 的请求/Token 周期配额及并发上限；每秒/分钟请求速率仍由反向代理控制。可使用以下 nginx 配置，阈值按实际负载调整：

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

## 本次验证边界

- `npm run typecheck`、`git diff --check` 通过；依赖安装审计报告 0 个已知漏洞。
- 整合后的全量测试：311 项通过、0 失败；首次目录检查发现 23 个残留。修复后仅复跑受影响的 87 项测试，全部通过，受检目录无残留。
- 目录检查继承出网守卫的回归先失败（守卫未加载），修复后通过；同时验证真实残留仍导致检查失败。
- 实际启动编译产物：`/health` 为版本 `20261020.2`、schema 11；未授权模型请求 401，管理页 200 且脚本语法有效，防嵌入头生效；Chat 长度截断、Responses 生成/读取与 Messages 请求通过。
- 模型测试和运行验证均使用假 Cursor SDK，数据库测试使用真实临时 SQLite；本轮没有发出真实 Cursor 请求。

最终 Node 矩阵和 Docker 构建结果以整合 PR 的 CI 为准。真实 Cursor 上游、实际计费、多账号权限及生产部署状态未由本轮验证。
