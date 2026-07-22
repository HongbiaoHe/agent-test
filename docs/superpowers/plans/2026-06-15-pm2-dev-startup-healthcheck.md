# pnpm dev 启动健康检查 + 清缓存 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pnpm dev` 启动前清掉前后端构建缓存，并在终端即时反馈服务起没起成功（失败 dump 日志 + 退出非 0）。

**Architecture:** 新增 `node scripts/dev.mjs` 包装脚本接管 `pnpm dev`：清缓存 → 重启 PM2 → 在超时窗口内轮询「PM2 进程状态 + 端口探活 + 日志错误标记」做健康判定。判定逻辑抽到纯函数模块 `scripts/dev-health.mjs`（可单测），I/O 编排留在 `dev.mjs`。PM2 守护模型与 `PM2_HOME=./.pm2` 不变。

**Tech Stack:** Node ≥18 ESM（`node:fs/promises`、`node:net`、`node:child_process`）、Node 内置测试运行器 `node:test`（不引新依赖）、PM2 7、pnpm workspace。

> **CLAUDE.md §0 约束**：执行本计划的 agent **不得自行 `git commit`**。下方 commit 步骤的命令仅供用户复核后自行执行；agent 只 `git add` 暂存即可，提交留给用户。

---

## 关键事实（已在仓库核对）

- `package.json` 当前 `"dev": "PM2_HOME=./.pm2 pm2 start ecosystem.config.cjs"`；`dev:stop/restart/logs/status` 均走 `PM2_HOME=./.pm2 pm2 ...`。
- `ecosystem.config.cjs`：`backend` = `pnpm --filter backend start:dev`（`nest start --watch`，端口 **3101**）；`frontend` = 等 3101 后 `pnpm --filter frontend dev`（`next dev -p 3100`）。
- 缓存目录：前端 `apps/frontend/.next`（含 Turbopack 缓存）、后端 `apps/backend/dist`。
- PM2 `jlist` 每个 app 的 `pm2_env` 提供 `status`、`restart_time`、`pm_out_log_path`、`pm_err_log_path`（绝对路径）—— 健康判定与日志 tail 都用它，不猜文件名。
- 本机默认 shell 可能是 node 14；但 `engines.node>=22` 且 pnpm@11 要求 node≥18，故 `pnpm dev` 必在 node≥18 下运行，`node --test` 可用。

## File Structure

- **Create `scripts/dev-health.mjs`** —— 纯判定逻辑（无 I/O）：`ERROR_MARKERS`、`scanLogForErrors(text)`、`evaluatePm2Status(apps, baseline)`、`evaluateTick({apps,baseline,ports,logs})`。唯一职责：把一帧快照映射成 `failed/ready/pending` 决策。可单测。
- **Create `scripts/dev-health.test.mjs`** —— 上面纯函数的 `node:test` 单测。
- **Create `scripts/dev.mjs`** —— I/O 编排（胶水）：清缓存、`pm2 delete→flush→start`、轮询探活/读日志、调用 `evaluateTick` 决策、成功 ✅ 退 0 / 失败 dump 日志退 1。
- **Modify `package.json`** —— `"dev"` 改为 `node scripts/dev.mjs`；新增 `"test:scripts": "node --test scripts/*.test.mjs"`。
- **不动** `ecosystem.config.cjs`。

> 对 spec 的一处细化：`dev.mjs` 在 `pm2 start` 前先 `pm2 delete`（忽略「未运行」错误）再 `pm2 flush`，确保「清缓存时无进程占用、本次为全新进程与全新日志」——否则 `pm2 start` 对已 online 的 app 是幂等空操作，清缓存就失去意义、且日志里会混入上一次运行的旧错误标记导致误判。

---

## Chunk 1: 健康检查脚本 + 接线

### Task 1: 纯判定逻辑（TDD）

**Files:**
- Create: `scripts/dev-health.mjs`
- Test: `scripts/dev-health.test.mjs`

- [ ] **Step 1: 写失败测试** `scripts/dev-health.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanLogForErrors,
  evaluatePm2Status,
  evaluateTick,
} from './dev-health.mjs';

test('scanLogForErrors 命中前端编译错误', () => {
  assert.equal(scanLogForErrors('xxx\nFailed to compile\nyyy'), 'Failed to compile');
  assert.equal(scanLogForErrors("Found 3 error(s)."), 'Found \\d+ error');
});

test('scanLogForErrors 干净日志返回 null', () => {
  assert.equal(scanLogForErrors('Ready in 1200ms\nNest application successfully started'), null);
  assert.equal(scanLogForErrors(''), null);
});

test('evaluatePm2Status: errored / 崩溃重启 / 正常', () => {
  const baseline = new Map([['backend', 0], ['frontend', 0]]);
  const errored = [{ name: 'backend', pm2_env: { status: 'errored', restart_time: 0 } }];
  assert.equal(evaluatePm2Status(errored, baseline).length, 1);

  const crashed = [{ name: 'frontend', pm2_env: { status: 'online', restart_time: 3 } }];
  assert.equal(evaluatePm2Status(crashed, baseline)[0].name, 'frontend');

  const healthy = [{ name: 'backend', pm2_env: { status: 'online', restart_time: 0 } }];
  assert.equal(evaluatePm2Status(healthy, baseline).length, 0);
});

test('evaluateTick: 失败 / ready / pending', () => {
  const baseline = new Map([['backend', 0], ['frontend', 0]]);
  const onlineApps = [
    { name: 'backend', pm2_env: { status: 'online', restart_time: 0 } },
    { name: 'frontend', pm2_env: { status: 'online', restart_time: 0 } },
  ];

  const failed = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: true },
    logs: { backend: '', frontend: 'Module not found' },
  });
  assert.equal(failed.decision, 'failed');
  assert.equal(failed.failures[0].name, 'frontend');

  const ready = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: true },
    logs: { backend: '', frontend: '' },
  });
  assert.equal(ready.decision, 'ready');

  const pending = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: false },
    logs: { backend: '', frontend: '' },
  });
  assert.equal(pending.decision, 'pending');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（先切 node 22，见记忆 node-version-jest-false-green）：
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
node --test scripts/dev-health.test.mjs
```
Expected: FAIL —— `Cannot find module './dev-health.mjs'`（文件还没建）。

- [ ] **Step 3: 写最小实现** `scripts/dev-health.mjs`

```js
// 纯判定逻辑，无 I/O，便于单测。被 scripts/dev.mjs 调用。

// 启动期日志错误标记（best-effort）：next dev / nest watch 编译报错时进程不崩，
// 只能靠扫日志抓。刻意排除泛化的 "Error:" 以免误杀正常启动日志。
export const ERROR_MARKERS = [
  'Failed to compile',
  'Module not found',
  'Cannot find module',
  /Found \d+ error/,
];

export function scanLogForErrors(text) {
  if (!text) return null;
  for (const m of ERROR_MARKERS) {
    if (typeof m === 'string') {
      if (text.includes(m)) return m;
    } else if (m.test(text)) {
      return m.source;
    }
  }
  return null;
}

// apps: `pm2 jlist` 结果；baseline: Map<name, 启动时 restart_time>
export function evaluatePm2Status(apps, baseline) {
  const failures = [];
  for (const app of apps) {
    const env = app.pm2_env ?? {};
    const status = env.status;
    const restarts = env.restart_time ?? 0;
    const base = baseline.get(app.name) ?? 0;
    if (status === 'errored' || status === 'stopped') {
      failures.push({ name: app.name, reason: `进程状态 ${status}` });
    } else if (restarts > base) {
      failures.push({ name: app.name, reason: `启动后崩溃重启 ${restarts - base} 次` });
    }
  }
  return failures;
}

// 单帧快照 → 决策。input: { apps, baseline, ports:{name:bool}, logs:{name:string} }
export function evaluateTick({ apps, baseline, ports, logs }) {
  const failures = evaluatePm2Status(apps, baseline);
  for (const [name, text] of Object.entries(logs ?? {})) {
    const hit = scanLogForErrors(text);
    if (hit) failures.push({ name, reason: `日志命中错误标记: ${hit}` });
  }
  if (failures.length) return { decision: 'failed', failures };
  const allPortsUp = ports && Object.values(ports).length > 0
    && Object.values(ports).every(Boolean);
  return { decision: allPortsUp ? 'ready' : 'pending', failures: [] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test scripts/dev-health.test.mjs
```
Expected: PASS —— `# pass 4` / `# fail 0`。

- [ ] **Step 5: 暂存（提交留给用户）**

```bash
git add scripts/dev-health.mjs scripts/dev-health.test.mjs
# 提交命令仅供用户执行（CLAUDE.md §0 禁止 agent 自行 commit）：
# git commit -m "feat(dev): 新增 pnpm dev 健康判定纯函数 + 单测"
```

---

### Task 2: 编排脚本 `scripts/dev.mjs`

**Files:**
- Create: `scripts/dev.mjs`

- [ ] **Step 1: 写脚本**

```js
#!/usr/bin/env node
// pnpm dev 包装：清缓存 → 重启 PM2 → 健康检查（成功退 0 / 失败 dump 日志退 1）。
// PM2 守护模型不变；本脚本本身常驻到健康判定结束即退出，daemon 后台留着。
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

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

import { evaluateTick } from './dev-health.mjs';

async function main() {
  // 1) 确保全新启动：删旧进程 + 清旧日志（清缓存前先释放占用）
  pm2Quiet(['delete', 'ecosystem.config.cjs']);
  pm2Quiet(['flush']);

  // 2) 清前后端构建缓存
  for (const rel of CACHES) {
    const abs = path.join(ROOT, rel);
    if (existsSync(abs)) {
      await rm(abs, { recursive: true, force: true });
      console.log(`🧹 已清缓存 ${rel}`);
    }
  }

  // 3) 启动
  console.log('🚀 pm2 start ecosystem.config.cjs');
  pm2(['start', 'ecosystem.config.cjs'], { stdio: 'inherit' });

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

main().catch((e) => { console.error('dev.mjs 异常：', e); process.exit(1); });
```

- [ ] **Step 2: 语法自检（不真正起服务）**

Run:
```bash
node --check scripts/dev.mjs && echo "syntax-ok"
```
Expected: `syntax-ok`（无语法错误）。

- [ ] **Step 3: 暂存**

```bash
git add scripts/dev.mjs
# 用户自行： git commit -m "feat(dev): pnpm dev 启动健康检查编排脚本"
```

---

### Task 3: 接线 package.json

**Files:**
- Modify: `package.json:11`（`scripts.dev`）

- [ ] **Step 1: 改 dev、加 test:scripts**

把
```json
"dev": "PM2_HOME=./.pm2 pm2 start ecosystem.config.cjs",
```
改为
```json
"dev": "node scripts/dev.mjs",
"test:scripts": "node --test scripts/*.test.mjs",
```
（`dev:stop/restart/logs/status` 保持不变；`dev.mjs` 内部已自带 `PM2_HOME=./.pm2`。）

- [ ] **Step 2: 跑脚本单测确认仍绿**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
pnpm test:scripts
```
Expected: PASS（4 个测试全过）。

- [ ] **Step 3: 暂存**

```bash
git add package.json
# 用户自行： git commit -m "chore(dev): pnpm dev 切到健康检查脚本 + test:scripts"
```

---

## 集成验证（必须实跑，写进最终 Verification）

> 这些验证会真正起/停服务。按记忆 pm2-local-home-guards-dev-ports：测前若 preview 在跑要先停；测完恢复。

- [ ] **V1 正常路径**：`pnpm dev` → 应看到 `🧹 已清缓存…` ×2、`🚀`、`⏳`，最终 `✅ 服务已就绪` + 两个 URL，进程退出码 0。随后 `pnpm dev:status` 两个 app 均 `online`。
- [ ] **V2 后端硬失败**：先 `pnpm dev:stop`；临时占用 3101（如 `node -e "require('net').createServer().listen(3101)"` 另开窗口）或在 `apps/backend/src/main.ts` 顶部加 `throw new Error('boom')`；跑 `pnpm dev` → 应退出码 **1** 并打印 backend 日志尾部。**还原临时改动**。
- [ ] **V3 前端编译失败**：临时在某前端文件引入编译错误（如乱写一行 `const x: =;`）；`pnpm dev` → 应命中日志标记（`Failed to compile`/`Module not found` 等）退出码 1。**还原临时改动**。
- [ ] **V4 收尾**：`pnpm dev:stop`，确认无残留；如测前停过 preview 则恢复（记忆 preview-restore-desktop-after-resize / pm2-local-home-guards-dev-ports）。

## Done 标准（CLAUDE.md §0）

最终汇报必须含 `## Verification`：`node --check` / `pnpm test:scripts` 实际输出，V1–V3 的实际退出码与关键日志，并对「3101/3100、缓存目录、退出码」给 `file:line` 或实跑结果佐证。`pnpm lint` 对改动文件 0 error。提交由用户执行，agent 不 commit。
```