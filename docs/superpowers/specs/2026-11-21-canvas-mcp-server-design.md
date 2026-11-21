# 画布 MCP 对外服务设计

> 2026-11-21 grilling 定稿。目标：第三方 agent（Claude Code / Cursor 等）经 MCP 像画布 agent 一样操作画布；
> 授权既走 MCP 规范 OAuth，也能把个人访问令牌（PAT）直接写进 mcp.json。

## 决策一览

| # | 决策 |
|---|---|
| 1 | 只暴露**底层画布工具**，第三方 agent 自己当大脑（不做"委托我方画布 agent"） |
| 2 | **账号级**授权：`list_canvases` / `create_canvas` + 每个画布工具带 `canvasId` |
| 3 | **隐式运行锁**：写工具每次调用自动申请/续期（holder = 授权 id，TTL 60s）；读不锁 |
| 4 | 自建 OAuth AS，复用 SDK `server/auth` 的 handler + 自实现 `OAuthServerProvider` |
| 5 | PAT：只显示一次、只存哈希、可吊销；与 OAuth 授权统一在「已授权应用」管理 |
| 6 | scope：`canvas:read` / `canvas:write` / `media:generate`；没授权的工具不出现在 `tools/list` |
| 7 | 不走我方审批；工具带 annotations，由客户端确认 |
| 8 | 新增 `get_canvas`、`wait_for_generations(≤60s)`；产物只回 URL |
| 9 | `import_asset(url)`：仅 https + SSRF 防护 + 上传白名单 |
| 10 | 全部挂主站域名，Next rewrites 透传后端 |
| 11 | 无状态 + 纯 JSON 响应（`enableJsonResponse`，无 session id） |
| 12 | 适配层复用 agent-core 工具，覆盖描述（串行调用） |
| 13 | `actor` 仍为 `agent`；锁 holderId = `mcp:<授权 id>`、label = 客户端在 initialize 自报的 clientInfo（title 优先，记在 Redis `mcp-srv:client:<grantId>`；没报过时 OAuth 用 DCR 名、PAT 用令牌名），网页端据前缀显示「<agent> is editing」+ 品牌 logo（simple-icons）；不做审计日志 |
| 14 | 只做 DCR；access 1h，refresh 30d 轮换 |
| 15 | MySQL 存 client / grant / token 哈希；授权码与同意页中间态存 Redis |
| 16 | 只做 Web：`/settings/mcp-server` + `/oauth/consent` |
| 17 | 验收：单测 + SDK Client 真连协议 e2e（PAT 与 OAuth 全链路）+ Playwright；生成链路用画布 mockMedia 跑 |

## 端点（对外均为主站域名，经 Next rewrites → 后端同路径）

| 路径 | 说明 |
|---|---|
| `POST /mcp` | MCP Streamable HTTP（无状态 JSON）；`GET/DELETE /mcp` → 405 |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 资源元数据 |
| `/.well-known/oauth-authorization-server` | RFC 8414 AS 元数据（issuer = 主站 origin） |
| `/oauth/authorize` `/oauth/token` `/oauth/register` `/oauth/revoke` | SDK handler 挂在 `/oauth/*` 前缀，避免与前端页面路由冲突 |
| 前端 `/oauth/consent?request=<id>` | 同意页（未登录先跳 `/login?next=`） |
| 后端 `/mcp-server/*`（JWT） | 同意页取详情 / 允许 / 拒绝；PAT 创建；授权列表 / 吊销 |

公网 origin：`MCP_PUBLIC_URL`，缺省 `CORS_ORIGIN` 第一项。

## 数据

- `McpOAuthClient`：DCR 注册信息（client_id、metadata JSON；机密客户端的 secret 用 MCP_TOKEN_ENC_KEY 加密存——SDK 的客户端认证要拿明文比对，不能只存哈希）。
- `McpGrant`：一条授权（kind=oauth|pat、userId、tenantId、name、clientId?、scopes、lastUsedAt、revokedAt、expiresAt）。
- `McpToken`：grant 下的 token（kind=access|refresh|pat、SHA-256 哈希、expiresAt）。
- Redis：`mcp-srv:authreq:<id>`（同意页中间态，10 分钟）、`mcp-srv:code:<code>`（授权码，10 分钟，一次性）。

token 形如 `cvs_at_…` / `cvs_rt_…` / `cvs_pat_…`（32 字节随机 base64url）。refresh 轮换：旧 refresh 立即作废，
同 grant 的旧 access 保留到自然过期。吊销 grant → 其下所有 token 校验失败。

## 工具

| 工具 | scope | annotations |
|---|---|---|
| `list_canvases` `get_canvas` `list_media_models` `wait_for_generations` | canvas:read | readOnly |
| `create_canvas` `add_node(s)` `update_node(s)` `connect_nodes` `set_node_model` `set_clip_order` `import_asset` | canvas:write | — |
| `delete_node` `clear_canvas` | canvas:write | destructive |
| `generate_media_node` `merge_video_node` | media:generate | openWorld |

共享工具在适配层按请求构造（backend 绑定 canvasId、uploadScope = canvasId），入参 = 共享 schema + `canvasId`。
写工具调用前 `acquireRunLock(canvasId, tenantId, holder=mcp:<grantId>, label=agent 名)`；`CANVAS_BUSY` 等业务错误回一句话。
