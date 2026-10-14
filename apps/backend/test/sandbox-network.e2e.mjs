#!/usr/bin/env node
/**
 * 沙箱网络设置端到端测试：真实后端（localhost:3101）+ 真实 E2B / Daytona 沙箱。
 *
 * 设置一律走 PATCH /sandbox/settings（与 /settings/sandbox 页面同一请求）；是否真的生效，
 * 用提供方 SDK 进沙箱 curl 外网来判定（不依赖模型输出）。需要触发 getUserSandbox（暂停期间
 * 改的设置在下次运行时同步、首次创建沙箱）时，发一条不调用工具的简单会话。
 * 测试账号的沙箱一律保留，不删除。
 *
 * 运行（apps/backend 下）：NODE_USE_ENV_PROXY=1 node test/sandbox-network.e2e.mjs
 * 只测某一部分：E2E_PARTS=e2b,inbound,daytona（缺省全部）
 */
import assert from 'node:assert/strict';
import { Daytona } from '@daytonaio/sdk';
import { CommandExitError, Sandbox } from 'e2b';

process.loadEnvFile('.env');
const API = process.env.E2E_API ?? 'http://localhost:3101';
const PARTS = (process.env.E2E_PARTS ?? 'e2b,inbound,daytona').split(',');
const MODEL = 'deepseek:deepseek-flash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name} (${Date.now() - t0}ms)${note ? ` — ${note}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`❌ ${name} — ${err?.message ?? err}`);
  }
}

function client() {
  let token = '';
  const call = async (path, init = {}) => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const ok = async (path, init) => {
    const r = await call(path, init);
    assert.equal(r.code, 0, `${path} → ${r.status} ${r.message}`);
    return r.data;
  };
  const login = async (email) => {
    for (let i = 0; i < 3; i++) {
      const sent = await call('/auth/send-code', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      if (sent.data?.code) {
        token = (
          await ok('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, code: sent.data.code }),
          })
        ).token;
        return;
      }
      await sleep(61_000);
    }
    throw new Error('拿不到验证码');
  };
  const patch = (body) =>
    ok('/sandbox/settings', { method: 'PATCH', body: JSON.stringify(body) });
  /** 发一条不调用工具的会话：只为触发 worker 的 getUserSandbox（创建 / 同步出站规则）。 */
  const touchRun = async () => {
    const { conversationId } = await ok('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        goal: '只回复 OK 两个字母，不要调用任何工具。',
        model: MODEL,
      }),
    });
    for (let i = 0; i < 90; i++) {
      const c = await ok(`/conversations/${conversationId}`);
      if (['done', 'failed', 'stopped'].includes(c.status)) {
        const warn = c.messages.find((m) =>
          JSON.stringify(m.content).includes('降级'),
        );
        return { status: c.status, warn };
      }
      await sleep(2000);
    }
    throw new Error('会话超时');
  };
  return { call, ok, login, patch, touchRun };
}

const CURL = (url) =>
  `curl -s -o /dev/null -w '%{http_code}' --max-time 8 ${url} || true`;

async function e2bProbe(id, url) {
  const sbx = await Sandbox.connect(id, { timeoutMs: 5 * 60_000 });
  try {
    return (
      await sbx.commands.run(CURL(url), { timeoutMs: 30_000 })
    ).stdout.trim();
  } catch (e) {
    if (e instanceof CommandExitError) return e.stdout.trim();
    throw e;
  }
}

async function daytonaProbe(id, url) {
  const sb = await new Daytona().get(id);
  return (
    await sb.process.executeCommand(CURL(url), undefined, undefined, 30)
  ).result.trim();
}

const reachable = (code) => /^[1-5]\d\d$/.test(code) && code !== '000';

// ─── E2B：运行中修改出站 + 暂停期间修改、下次运行同步 ──────────────────────────
if (PARTS.includes('e2b')) {
  const c = client();
  let id = '';
  await step('[E2B] 登录测试账号并切到 E2B、出站开放', async () => {
    await c.login('e2e-spark-sandbox@example.test');
    const s = await c.patch({ provider: 'e2b', egressMode: 'open' });
    assert.equal(s.current, 'e2b');
    const run = await c.touchRun();
    assert.equal(run.status, 'done');
    const st = await c.ok('/sandbox/status');
    assert.equal(st.state, 'started');
    id = st.id;
    return `sandbox=${id}`;
  });

  await step('[E2B] 非法白名单 → 400', async () => {
    const r = await c.call('/sandbox/settings', {
      method: 'PATCH',
      body: JSON.stringify({ allowList: ['http://pypi.org'] }),
    });
    assert.equal(r.status, 400);
  });

  await step(
    '[E2B] 白名单只放行 pypi.org → 立即生效：pypi 通、github 不通',
    async () => {
      const s = await c.patch({
        egressMode: 'allowlist',
        allowList: ['pypi.org'],
      });
      assert.equal(s.egressSync, 'applied');
      const pypi = await e2bProbe(id, 'https://pypi.org/simple/');
      const gh = await e2bProbe(id, 'https://github.com');
      assert.ok(reachable(pypi), `pypi=${pypi}`);
      assert.ok(!reachable(gh), `github=${gh}`);
      const info = await Sandbox.getInfo(id);
      return `pypi=${pypi} github=${gh} remote=${JSON.stringify(info.network ?? {})}`;
    },
  );

  await step('[E2B] 全部禁止 → pypi 也不通', async () => {
    const s = await c.patch({ egressMode: 'blocked' });
    assert.equal(s.egressSync, 'applied');
    const pypi = await e2bProbe(id, 'https://pypi.org/simple/');
    assert.ok(!reachable(pypi), `pypi=${pypi}`);
    return `pypi=${pypi}`;
  });

  await step('[E2B] 开放 → github 恢复', async () => {
    const s = await c.patch({ egressMode: 'open' });
    assert.equal(s.egressSync, 'applied');
    const gh = await e2bProbe(id, 'https://github.com');
    assert.ok(reachable(gh), `github=${gh}`);
    return `github=${gh}`;
  });

  await step('[E2B] 暂停期间改成禁止 → pending；下次运行时同步', async () => {
    await Sandbox.pause(id);
    const s = await c.patch({ egressMode: 'blocked' });
    assert.equal(s.egressSync, 'pending');
    const before = await Sandbox.getInfo(id);
    assert.equal(before.state, 'paused');
    const run = await c.touchRun();
    assert.equal(run.status, 'done');
    const info = await Sandbox.getInfo(id);
    assert.ok(
      info.network?.denyOut?.includes('0.0.0.0/0'),
      JSON.stringify(info.network),
    );
    const pypi = await e2bProbe(id, 'https://pypi.org/simple/');
    assert.ok(!reachable(pypi), `pypi=${pypi}`);
    // 恢复开放，免得影响后续使用
    assert.equal((await c.patch({ egressMode: 'open' })).egressSync, 'applied');
    return `同步后 denyOut=${JSON.stringify(info.network.denyOut)} pypi=${pypi}`;
  });
}

// ─── E2B 入站：新沙箱默认需鉴权 ───────────────────────────────────────────────
if (PARTS.includes('inbound')) {
  const c = client();
  await step('[E2B 入站] 新账号新沙箱：端口公网地址需令牌', async () => {
    await c.login('e2e-sandbox-network@example.test');
    const s = await c.patch({
      provider: 'e2b',
      egressMode: 'open',
      publicTraffic: false,
    });
    assert.equal(s.network.publicTraffic, false);
    const run = await c.touchRun();
    assert.equal(run.status, 'done');
    const st = await c.ok('/sandbox/status');
    const cur = await c.ok('/sandbox/settings');
    assert.equal(
      cur.currentPublicTraffic,
      false,
      `currentPublicTraffic=${cur.currentPublicTraffic}`,
    );
    const sbx = await Sandbox.connect(st.id, { timeoutMs: 5 * 60_000 });
    const srv = await sbx.commands.run(
      'cd /tmp && echo probe > p.txt && python3 -m http.server 8765',
      { background: true },
    );
    await sleep(2500);
    const res = await fetch(`https://${sbx.getHost(8765)}/p.txt`);
    await srv.kill();
    assert.ok(
      res.status === 401 || res.status === 403,
      `inbound=${res.status}`,
    );
    return `sandbox=${st.id} 无令牌访问 → ${res.status}`;
  });
}

// ─── Daytona：Tier 1/2 账户不允许沙箱级出站策略 → 保存报错并回滚；组织策略只放行常用服务 ───
if (PARTS.includes('daytona')) {
  const c = client();
  let id = '';
  await step('[Daytona] 切到 Daytona（出站开放）并确保沙箱运行', async () => {
    await c.login('e2e-spark-sandbox@example.test');
    const s = await c.patch({ provider: 'daytona', egressMode: 'open' });
    assert.equal(s.current, 'daytona');
    const run = await c.touchRun();
    assert.equal(run.status, 'done', `run=${run.status}`);
    const st = await c.ok('/sandbox/status');
    assert.equal(st.provider, 'daytona');
    assert.equal(st.state, 'started');
    id = st.id;
    return `sandbox=${id}`;
  });

  await step(
    '[Daytona] 保存「禁止」→ 40010 不支持，设置回滚为 open',
    async () => {
      const r = await c.call('/sandbox/settings', {
        method: 'PATCH',
        body: JSON.stringify({ egressMode: 'blocked' }),
      });
      assert.equal(r.status, 400);
      assert.equal(r.code, 40010, JSON.stringify(r));
      const s = await c.ok('/sandbox/settings');
      assert.equal(s.network.egress, 'open');
      return r.message;
    },
  );

  await step('[Daytona] 组织级策略：常用服务可达、其他站点被拦', async () => {
    const pypi = await daytonaProbe(id, 'https://pypi.org/simple/');
    const ex = await daytonaProbe(id, 'https://example.com');
    assert.ok(reachable(pypi), `pypi=${pypi}`);
    assert.ok(!reachable(ex), `example.com=${ex}`);
    return `pypi=${pypi} example.com=${ex}`;
  });

  await step(
    '[Daytona] 存着「禁止」时切到 Daytona：本轮照常使用沙箱（出站由 Daytona 管理）',
    async () => {
      await c.patch({ provider: 'e2b' });
      assert.equal(
        (await c.patch({ egressMode: 'blocked' })).network.egress,
        'blocked',
      );
      const s = await c.patch({ provider: 'daytona' });
      assert.equal(s.current, 'daytona');
      assert.equal(
        s.providers.find((p) => p.name === 'daytona').supportsEgressControl,
        false,
      );
      const run = await c.touchRun();
      assert.equal(run.status, 'done');
      assert.ok(
        !run.warn,
        `出现降级提示：${JSON.stringify(run.warn?.content)}`,
      );
      await c.patch({ provider: 'e2b' });
      assert.equal(
        (await c.patch({ egressMode: 'open' })).network.egress,
        'open',
      );
    },
  );

  await step('[Daytona] 切回 E2B（保持测试账号原状）', async () => {
    assert.equal((await c.patch({ provider: 'e2b' })).current, 'e2b');
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
