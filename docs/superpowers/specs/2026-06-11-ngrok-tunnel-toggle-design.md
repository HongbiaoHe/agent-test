# ngrok 隧道开关设计（方案 A：入口叠加 + 纯进程控制）

日期：2026-06-11
状态：已获用户确认

## 背景与目标

希望能方便地在「localhost 访问」与「ngrok 内网穿透访问」之间切换，开新隧道前先停掉占用中的 ngrok（buzz-video 在用，已确认可停），手机能通过穿透地址登录使用。

历史：c152450 曾按要求撤回内网访问兼容回到 localhost-only；本设计在 ngrok 场景下恢复其中仍然必要的部分。

核心洞察：**localhost 与隧道访问不互斥**。配置层一次改好后，localhost 永远可用，隧道只是叠加入口——"切换"退化为 ngrok 进程的开/关，dev server 全程不重启、不感知。

约束与取舍（用户已确认）：

- 控制形态：命令行脚本（不做网页 UI 开关）
- ngrok 随机域名即可（不认领固定域名；脚本留 `NGROK_DOMAIN` 扩展口）
- 鉴权：穿透域名下邮箱登录可用即可；passkey 维持现状（域名绑定，不强求手机可用）

## 架构

```
手机/外网 ──https──▶ xxx.ngrok-free.app ──▶ ngrok agent ──▶ localhost:3100 (Next dev)
                                                              │  /api-backend/* rewrite（已存在）
                                                              ▼
                                                       localhost:3101 (NestJS)
本机浏览器 ──────────────────────────────────────────▶ localhost:3100（不变，始终可用）
```

单隧道即全功能：浏览器侧 REST 与 socket.io 均走同源前缀 `/api-backend/*` 反代（apps/frontend/next.config.ts rewrites，已存在），只需暴露 3100。`ngrok-skip-browser-warning` 头已在 api.ts / socket.ts 加好。

## 变更点（3 文件 + package.json）

### 1. `scripts/tunnel.mjs`（新增，~80 行）

`pnpm tunnel`（= `node scripts/tunnel.mjs`）：

1. `pkill -f 'ngrok (http|start)'` 杀宿主机全部 ngrok（免费版同时仅一个 agent 会话；buzz-video 的隧道一并停掉，已确认可接受）
2. 后台启动 `ngrok http 3100`；`.env` 配了 `NGROK_DOMAIN` 则带 `--url=<domain>`（本次默认不配）
3. 轮询 `http://localhost:4040/api/tunnels` 取公网 URL，15s 超时则报错并附 ngrok 日志摘要（覆盖账号会话冲突、authtoken 失效）
4. 打印 URL + 终端二维码（`qrcode-terminal`，加在**根 package.json** 的 devDependencies——脚本位于根 `scripts/`），手机扫码直达

`pnpm tunnel:off`：杀 ngrok 进程并确认。

脚本不写配置文件、不碰 dev server。

### 2. `apps/frontend/next.config.ts`

`allowedDevOrigins: ["localhost", "*.ngrok-free.app", "*.ngrok-free.dev"]`。
（实现期实测：ngrok v3.34.1 随机域名发 `*.ngrok-free.dev`，固定域名是 `*.ngrok-free.app`，两者都放行。）

依据：Next 16 内置文档（node_modules/next/dist/docs/.../allowedDevOrigins.md）示例明确支持 `*.` 通配子域；实现位于 block-cross-site-dev.js → isCsrfOriginAllowed。通配使随机/固定域名均无需重启 dev server。

风险评估：该选项仅防护「第三方网页跨源拉取本机 dev 资源」，放行 `*.ngrok-free.app` 攻击面极小，且仅 dev 生效。

### 3. `apps/frontend/src/middleware.ts`

恢复 5d4c225 的跳转写法：用 `x-forwarded-host ?? host` + `x-forwarded-proto` 构造跳转 base，替代 `nextUrl.origin`。

依据：Next 16 dev 将 req.url 规范化为 localhost（5d4c225 提交信息记录了 /api/echo-host 实测：headers.host=192.168.1.4 而 req.url=localhost），导致手机经隧道访问时被重定向到不可达的 localhost:3100。ngrok 转发保留原始 Host 且带 x-forwarded-proto=https，此写法同时修复 ngrok 与内网 IP 两种场景。

## 鉴权数据流

手机打开隧道地址 → middleware 用请求头跳同域 `/login` → 输邮箱 → NextAuth Credentials `authorize`（服务端执行）直连 `BACKEND_INTERNAL_URL=localhost:3101` 调 `/auth/login` 拿后端 JWT → session cookie 写在 ngrok 域名下。`trustHost: true` 已就绪（auth.ts:22）。

passkey 不动：rpId/origin 本就由前端按 window.location 动态传（passkey.controller.ts），各域名各自注册使用。

实现期验证项（既有行为确认，非新改动）：

- `.env.local` 的 `AUTH_URL=http://localhost:3100` 是否将回调 pin 在 localhost——若是则移除（trustHost 模式下 NextAuth 从请求推断 base）
- https 下 NextAuth secure cookie（`__Secure-` 前缀）与 localhost http cookie 并行互不干扰（预期各域各 cookie，无冲突）

## 错误处理

| 场景 | 行为 |
|---|---|
| 本机 shell 配了全局代理 | spawn 前剔除 HTTP(S)_PROXY/ALL_PROXY 环境变量（免费版 ngrok 走代理报 ERR_NGROK_9009，实现期实测） |
| ngrok 未安装/未配 authtoken | 检测 `which ngrok` 与启动输出，给装机/authtoken 指引 |
| 免费版会话冲突（别处在跑） | 轮询超时后打印 ngrok 实际报错 |
| dev server 未启动 | 检测 3100 未监听 → 打印警告后**继续开隧道**（不中止；ngrok 侧表现 502，dev server 起来即恢复） |
| 重复执行 `pnpm tunnel` | 幂等：先杀后起，得到新隧道 |

## 测试与验收

- 脚本手动验收：开（URL+二维码、旧进程被杀）→ 关（进程消失）→ 重复开（幂等）
- 手机路径：扫码 → /login → 邮箱登录 → /agent → 发消息收到流式回复（验证 socket.io 反代）
- localhost 回归：隧道开/关两态下 localhost:3100 登录与对话正常
- 静态检查：`tsc --noEmit` + 现有 lint 通过
