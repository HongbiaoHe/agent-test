#!/usr/bin/env node
// pnpm dev 包装：清缓存 → 重启 PM2 → 健康检查（成功退 0 / 失败 dump 日志退 1）。
// PM2 守护模型不变；本脚本本身常驻到健康判定结束即退出，daemon 后台留着。
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { evaluateTick } from './dev-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PM2_HOME = path.join(ROOT, '.pm2');
const PM2_BIN = path.join(ROOT, 'node_modules', '.bin', 'pm2');
const ENV = { ...process.env, PM2_HOME };

const TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 800;
const TAIL_LINES = 40;
const CACHES = ['apps/frontend/.next', 'apps/backend/dist'];
const TARGETS = [
  { name: 'backend', port: 3101, url: 'http://localhost:3101' },
  { name: 'frontend', port: 3100, url: 'http://localhost:3100' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pm2(args, opts = {}) {
  return execFileSync(PM2_BIN, args, { env: ENV, cwd: ROOT, ...opts });
}
function pm2Quiet(args) {
  try { pm2(args, { stdio: 'ignore' }); } catch { /* 未运行等，忽略 */ }
}
function jlist() {
  try { return JSON.parse(pm2(['jlist']).toString()); } catch { return []; }
}
function probe(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => done(true));
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => done(false));
  });
}
async function tail(p, lines = TAIL_LINES) {
  if (!p) return '';
  try { return (await readFile(p, 'utf8')).split('\n').slice(-lines).join('\n'); }
  catch { return ''; }
}

async function fail(failures, apps) {
  console.error('\n❌ 启动失败：');
  for (const f of failures) console.error(`   - ${f.name}: ${f.reason}`);
  const names = new Set(failures.map((f) => f.name));
  const dump = apps.filter((a) => names.has(a.name) || names.has('(timeout)'));
  for (const a of dump) {
    console.error(`\n──── ${a.name} 最近 ${TAIL_LINES} 行 ────`);
    console.error(await tail(a.pm2_env?.pm_err_log_path));
    console.error(await tail(a.pm2_env?.pm_out_log_path));
  }
  console.error('\n(进程保留未删；pnpm dev:logs 看完整日志，pnpm dev:stop 清理)');
  process.exit(1);
}

async function main() {
  // 1) 确保全新启动：删旧进程（清缓存前先释放占用）
  pm2Quiet(['delete', 'ecosystem.config.cjs']);

  // 2) 清前后端构建缓存
  for (const rel of CACHES) {
    const abs = path.join(ROOT, rel);
    if (existsSync(abs)) {
      await rm(abs, { recursive: true, force: true });
      console.log(`🧹 已清缓存 ${rel}`);
    }
  }

  // 3) 启动后清旧日志：flush 必须在 start 之后——app 重建后才能清掉其旧日志文件，
  // 否则上一轮的错误标记会污染日志扫描。硬崩由 PM2 状态兜底，编译错在窗口内持续打印仍可扫到。
  console.log('🚀 pm2 start ecosystem.config.cjs');
  pm2(['start', 'ecosystem.config.cjs'], { stdio: 'inherit' });
  pm2Quiet(['flush']);

  // 4) 基线 + 健康检查窗口
  const baseline = new Map(jlist().map((a) => [a.name, a.pm2_env?.restart_time ?? 0]));
  const deadline = Date.now() + TIMEOUT_MS;
  console.log(`⏳ 健康检查中（最多 ${TIMEOUT_MS / 1000}s）…`);

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const apps = jlist();
    const ports = {};
    for (const t of TARGETS) ports[t.name] = await probe(t.port);
    const logs = {};
    for (const a of apps) {
      logs[a.name] =
        (await tail(a.pm2_env?.pm_out_log_path)) + '\n' +
        (await tail(a.pm2_env?.pm_err_log_path));
    }
    const { decision, failures } = evaluateTick({ apps, baseline, ports, logs });

    if (decision === 'failed') return fail(failures, apps);
    if (decision === 'ready') {
      console.log('\n✅ 服务已就绪：');
      for (const t of TARGETS) console.log(`   ${t.name.padEnd(9)} ${t.url}`);
      console.log('   (PM2 后台常驻；pnpm dev:logs 查日志，pnpm dev:stop 停止)');
      process.exit(0);
    }
  }
  // 超时
  return fail([{ name: '(timeout)', reason: `${TIMEOUT_MS / 1000}s 内未全部就绪` }], jlist());
}

main().catch((e) => { console.error('dev.mjs 异常：', e); process.exit(1); });
