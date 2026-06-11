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
