# ngrok 隧道开关 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一条命令开/关 ngrok 隧道（开前先杀旧进程），手机扫码经穿透地址邮箱登录使用；localhost 访问全程不受影响。

**Architecture:** 「入口叠加」而非模式切换——配置层一次改好（`allowedDevOrigins` 通配 + middleware 请求头跳转），之后控制完全是 ngrok 进程的 start/stop（`scripts/tunnel.mjs`）。单隧道暴露 3100 即全功能（REST/socket.io 走既有 `/api-backend/*` 同源反代）。

**Tech Stack:** Node 22 原生 mjs 脚本（`child_process`/`net`/`fetch`）、ngrok v3 本地 API（`localhost:4040/api/tunnels`）、`qrcode-terminal`、Next 16 `allowedDevOrigins`。

**Spec:** `docs/superpowers/specs/2026-06-11-ngrok-tunnel-toggle-design.md`

**⚠️ 项目规则（覆盖本模板默认）：**
- **不自动 commit**（CLAUDE.md §0）——所有「Commit」步骤替换为「停下来等用户审阅」；只有用户明确要求时才提交。
- 任何「完成」声明必须带 `## Verification` 段（命令 + 实际输出 + file:line 引用）。
- 跑 jest/tsc 前先 `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`（默认 shell 是 node 14，jest 会静默假绿）。

**测试策略说明（为什么没有单测）：** `tunnel.mjs` 是围绕 ngrok 进程与本地 API 的 I/O 编排，mock 掉 ngrok 后单测只剩自说自话，无验证价值；根目录也无 jest 基建。验证靠每个 Task 的手动验收步骤（命令 + 预期输出都已写死）。前端两处改动是配置/中间件，靠 `tsc --noEmit` + 真实登录路径回归。

---

## Chunk 1: 全部实现（3 文件 + package.json，单 chunk）

### Task 1: `scripts/tunnel.mjs` + pnpm scripts + 依赖

**Files:**
- Create: `scripts/tunnel.mjs`
- Modify: `package.json`（根，scripts 节 + devDependencies）

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/biu/Desktop/agent-test
pnpm add -D -w qrcode-terminal
```

Expected: 根 `package.json` devDependencies 出现 `qrcode-terminal`（pm2 旁边）。

- [ ] **Step 2: 创建 `scripts/tunnel.mjs`（完整代码）**

```js
#!/usr/bin/env node
/**
 * ngrok 隧道开关（设计见 docs/superpowers/specs/2026-06-11-ngrok-tunnel-toggle-design.md）。
 *
 *   pnpm tunnel      —— 杀掉宿主机全部 ngrok（免费版仅一个 agent 会话）→ 开新隧道
 *                       （暴露 3100，REST/socket.io 走前端同源反代）→ 打印 URL + 二维码。
 *   pnpm tunnel:off  —— 杀 ngrok 进程，回纯 localhost。
 *
 * 固定域名扩展口：根 .env 或环境变量里配 NGROK_DOMAIN=xxx.ngrok-free.app 则带 --url。
 * ngrok 日志写文件而非 stdout 管道：父进程退出后管道关闭会让 ngrok 收 EPIPE 挂掉。
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";

const NGROK_LOG = "/tmp/agent-test-ngrok.log";
const PORT = 3100;

/** 杀全部 ngrok；pkill 无匹配时 exit 1，返回 false 表示本来就没在跑 */
function killNgrok() {
  try {
    execSync("pkill -f 'ngrok (http|tcp|tunnel|start)'");
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--off")) {
  console.log(killNgrok() ? "✓ 已停止 ngrok，回到纯 localhost。" : "没有在运行的 ngrok。");
  process.exit(0);
}

// ── 前置检查：ngrok 已安装 ──
try {
  execSync("which ngrok", { stdio: "ignore" });
} catch {
  console.error(
    "✗ 未找到 ngrok。安装：brew install ngrok（或 https://ngrok.com/download），" +
      "然后 ngrok config add-authtoken <token>（dashboard.ngrok.com 获取）。",
  );
  process.exit(1);
}

// ── 先停旧的（含 buzz-video 等其他项目的隧道，免费版同时只能跑一个）──
if (killNgrok()) {
  console.log("· 已停止原有 ngrok 进程");
  await sleep(500); // 等会话在 ngrok 云端释放
}

// ── dev server 未起只警告，不中止（隧道先开着，server 起来即可用）──
const devUp = await new Promise((res) => {
  const s = net.connect(PORT, "127.0.0.1");
  s.once("connect", () => (s.end(), res(true)));
  s.once("error", () => res(false));
});
if (!devUp) {
  console.warn(`⚠ localhost:${PORT} 未监听——dev server 没起？隧道照常开启（ngrok 侧暂时 502）。`);
}

// ── 起隧道（NGROK_DOMAIN：环境变量 > 根 .env，没有则随机域名）──
// .env 按脚本所在目录的上级（仓库根）解析，cwd 无关
const rootEnv = new URL("../.env", import.meta.url).pathname;
let domain = process.env.NGROK_DOMAIN;
if (!domain && existsSync(rootEnv)) {
  domain = readFileSync(rootEnv, "utf8").match(/^NGROK_DOMAIN=(.+)$/m)?.[1]?.trim();
}
rmSync(NGROK_LOG, { force: true });
const args = ["http", String(PORT), "--log", NGROK_LOG];
if (domain) args.push(`--url=${domain}`);
// 剔除代理变量：免费版 ngrok 走 http/s 代理会 ERR_NGROK_9009 直接挂（本机 shell 配了全局代理）
const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"])
  delete env[k];
const child = spawn("ngrok", args, { detached: true, stdio: "ignore", env });
child.unref();

// ── 轮询本地 API 拿公网地址，15s 超时 ──
let url = null;
for (let i = 0; i < 30 && !url; i++) {
  await sleep(500);
  if (child.exitCode !== null) break; // ngrok 没起来，直接读日志报错
  try {
    const body = await (await fetch("http://127.0.0.1:4040/api/tunnels")).json();
    url = body.tunnels?.find((t) => t.proto === "https")?.public_url ?? null;
  } catch {
    /* API 未就绪，继续等 */
  }
}

if (!url) {
  const log = existsSync(NGROK_LOG)
    ? readFileSync(NGROK_LOG, "utf8").trim().split("\n").slice(-15).join("\n")
    : "（无日志）";
  console.error(`✗ 15s 内未拿到隧道地址。ngrok 日志（截尾）：\n${log}`);
  killNgrok();
  process.exit(1);
}

const { default: qrcode } = await import("qrcode-terminal");
console.log(`\n✓ 隧道已开启：${url}`);
console.log("  手机扫码访问（登录用邮箱）：\n");
qrcode.generate(url, { small: true });
console.log("\n关闭：pnpm tunnel:off（localhost:3100 不受隧道开关影响）");
process.exit(0);
```

- [ ] **Step 3: 加 pnpm scripts**

`package.json`（根）`scripts` 节追加两行（放在 `"lint"` 之后；注意给现有最后一行 `"lint": "pnpm -r lint"` 补尾逗号，保持 JSON 合法）：

```json
    "tunnel": "node scripts/tunnel.mjs",
    "tunnel:off": "node scripts/tunnel.mjs --off"
```

- [ ] **Step 4: 验收——关（幂等）**

```bash
pnpm tunnel:off
```

Expected: `没有在运行的 ngrok。`（当前无进程）

- [ ] **Step 5: 验收——开**

```bash
pnpm tunnel
```

Expected: 打印 `✓ 隧道已开启：https://<random>.ngrok-free.dev` + 二维码（实测随机域名 TLD 为 .dev）；`pgrep -fl ngrok` 能看到进程；`curl -s -H 'ngrok-skip-browser-warning: 1' https://<random>.ngrok-free.app/login | head -c 200` 返回 HTML（dev server 在跑的前提下）。

- [ ] **Step 6: 验收——重复开（先杀后起）**

```bash
pnpm tunnel
```

Expected: 先打印 `· 已停止原有 ngrok 进程`，再给出（可能不同的）新地址；`pgrep -f ngrok | wc -l` 为 1。

- [ ] **Step 7: 验收——关**

```bash
pnpm tunnel:off && pgrep -fl ngrok || echo "已无 ngrok 进程"
```

Expected: `✓ 已停止 ngrok...` 且无残留进程。

- [ ] **Step 8: 停下来等用户审阅（不自动 commit）**

### Task 2: `allowedDevOrigins` 通配放行

**Files:**
- Modify: `apps/frontend/next.config.ts:8`

- [ ] **Step 1: 修改 allowedDevOrigins**

```ts
  // 允许经 ngrok 隧道域名访问 dev 资源（/_next/*）。否则 Next 16 dev 默认拦截跨源请求，
  // 导致隧道下页面拿不到 JS chunk、无法 hydrate（表现为按钮一直禁用、点击无反应）。
  // 通配子域：随机/固定 ngrok 域名均无需改配置重启（官方文档确认支持 *.）。
  // .dev 与 .app 都要：实测 v3.34.1 随机域名发 *.ngrok-free.dev，固定域名仍是 *.ngrok-free.app。
  allowedDevOrigins: ["localhost", "*.ngrok-free.app", "*.ngrok-free.dev"],
```

同文件第 11 行陈旧注释「仅暴露 3000」改为「仅暴露 3100」（端口早已迁移，spec 评审指出）。

- [ ] **Step 2: 类型检查 + lint**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/frontend && npx tsc --noEmit && pnpm lint
```

Expected: tsc 无输出；eslint 通过（spec 验收明确要求两者）。

- [ ] **Step 3: 验收（需 dev server 重启一次让本次配置生效，此后不再需要）**

重启 frontend dev server 后开隧道，手机或 `curl` 访问 `https://<domain>/_next/static/...`（从页面 HTML 里抓一个 chunk 路径）：

```bash
curl -s -o /dev/null -w '%{http_code}' -H 'ngrok-skip-browser-warning: 1' "https://<domain>/<某个 _next/static chunk 路径>"
```

Expected: `200`（改前跨源会被 403 拦截）。

- [ ] **Step 4: 停下来等用户审阅（不自动 commit）**

### Task 3: middleware 跳转改用请求头（恢复 5d4c225 写法）

**Files:**
- Modify: `apps/frontend/src/middleware.ts:9-23`

- [ ] **Step 1: 修改 middleware**

把 `export default auth((req) => {...})` 整段替换为（与被撤回的 5d4c225 完全一致）：

```ts
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = Boolean(req.auth);

  // 不要用 req.nextUrl.origin：Next 16 dev 把 req.url 规范化成 http://localhost:3100
  // （5d4c225 实测 /api/echo-host：headers.host=192.168.1.4 而 req.url=localhost），
  // 手机经 ngrok/内网 IP 访问时会被重定向到不可达的 localhost。改从请求头还原真实访问地址。
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3100";
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const base = `${proto}://${host}`;

  if (isLoggedIn && (pathname === "/" || pathname === "/login")) {
    return Response.redirect(new URL("/agent", base));
  }

  const needsAuth =
    pathname === "/" ||
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isLoggedIn && needsAuth) {
    return Response.redirect(new URL("/login", base));
  }
});
```

- [ ] **Step 2: 类型检查 + lint + localhost 回归**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/frontend && npx tsc --noEmit && pnpm lint
```

Expected: tsc 无输出；eslint 通过。然后用 preview 工具在 `localhost:3100` 验证：未登录访问 `/agent` → 跳 `/login`；登录后访问 `/login` → 跳 `/agent`（地址栏始终 localhost）。

- [ ] **Step 3: 隧道跳转验收**

隧道开启状态下：

```bash
curl -s -o /dev/null -w '%{redirect_url}' -H 'ngrok-skip-browser-warning: 1' "https://<domain>/agent"
```

Expected: `https://<domain>/login`（不是 `http://localhost:3100/login`）。

- [ ] **Step 4: 停下来等用户审阅（不自动 commit）**

### Task 4: 移除 `AUTH_URL`（验证项）+ 隧道登录验收

**Files:**
- Modify: `apps/frontend/.env.local`（删除 `AUTH_URL=http://localhost:3100` 行）

- [ ] **Step 1: 删除 AUTH_URL 并重启 frontend dev server**

删除 `.env.local` 第 8 行 `AUTH_URL=http://localhost:3100` 及其上方第 7 行的陈旧注释（「本地开发：next-auth 回调/重定向都用本机域名」——删变量后该注释失效）。`AUTH_TRUST_HOST=true` 保留——trustHost 模式下 NextAuth 从请求头推断 base。重启命令：`pnpm dev:restart`（根 package.json 已有）；若 dev server 由 preview 工具管理则用 preview 重启。

spec 评审已证实该变量把 NextAuth 回调 pin 在 localhost。

- [ ] **Step 2: localhost 登录回归**

preview 工具在 `localhost:3100/login` 走邮箱登录。Expected: 登录成功进 `/agent`，无 redirect_uri 异常。

- [ ] **Step 3: 隧道登录验收（手机或桌面浏览器开隧道地址）**

路径：`https://<domain>` → 跳 `/login` → 输邮箱 → 进 `/agent` → 发一条消息收到流式回复。

Expected: 全程地址栏停留在 ngrok 域名；流式回复正常（验证 socket.io 经 `/api-backend` 反代 + `ngrok-skip-browser-warning` 头）。若 cookie 不生效，检查浏览器是否拒绝 `__Secure-` cookie（预期 https 下正常；localhost http 与 ngrok https 各域各 cookie 互不影响）。

- [ ] **Step 4: 最终回归——隧道关闭后 localhost 不受影响**

```bash
pnpm tunnel:off
```

再用 preview 在 localhost 登录 + 对话一次。Expected: 正常。

- [ ] **Step 5: 停下来等用户审阅，由用户决定是否 commit**
