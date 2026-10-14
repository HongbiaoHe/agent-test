#!/usr/bin/env node
/**
 * Spark agent × 沙箱 端到端测试：真实后端（localhost:3101）+ 真实模型 + 真实云沙箱。
 *
 * 前置：后端已起（pnpm dev 或 preview），本地未配 RESEND_API_KEY（验证码随响应返回）。
 * 用专用测试账号登录：让 agent 在沙箱里执行 python 并把结果写成文件，然后经状态接口、
 * 目录/预览接口、会话文件列表/下载接口逐一核对。测试账号的沙箱保留（便于在界面上查看），
 * 闲置后按提供方策略自动停机/暂停。
 *
 * 运行（apps/backend 下）：node test/spark-sandbox.e2e.mjs
 * 先经设置接口（PATCH /sandbox/settings，与 /settings/sandbox 页面同一请求）把测试账号切到
 * E2E_EXPECT_PROVIDER=e2b|daytona（缺省 e2b）并设定闲置时长，再验证整条链路走的是该提供方、
 * 状态接口反映新的闲置时长；
 * 回答模型用 E2E_MODEL 指定（缺省 deepseek:deepseek-flash，须在 ALLOWED_MODELS 白名单内）。
 */
import assert from 'node:assert/strict';

const API = process.env.E2E_API ?? 'http://localhost:3101';
const EXPECT_PROVIDER = process.env.E2E_EXPECT_PROVIDER ?? 'e2b';
const MODEL = process.env.E2E_MODEL ?? 'deepseek:deepseek-flash';
/** 本轮设置的闲置时长：每次换一个值，验证生命周期设置真的生效到沙箱/状态接口 */
const IDLE_MINUTES = Number(process.env.E2E_IDLE_MINUTES ?? [10, 15, 30][Date.now() % 3]);
const EMAIL = 'e2e-spark-sandbox@example.test';
const RUN_TIMEOUT_MS = 6 * 60_000;
const NONCE = Date.now().toString(36);

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name} (${Date.now() - t0}ms)${note ? ` — ${note}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, note: String(err?.message ?? err) });
    console.log(`❌ ${name} — ${err?.message ?? err}`);
  }
}

let token = '';
async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}
const ok = async (path, init) => {
  const r = await call(path, init);
  assert.equal(r.code, 0, `${path} → ${r.status} ${r.message}`);
  return r.data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  for (let i = 0; i < 3; i++) {
    const sent = await call('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL }),
    });
    const code = sent.data?.code;
    if (code) {
      const r = await ok('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: EMAIL, code }),
      });
      token = r.token;
      return;
    }
    await sleep(61_000); // 60s 发送频率限制
  }
  throw new Error('拿不到验证码：确认本地没有配置 RESEND_API_KEY');
}

async function waitDone(id) {
  const t0 = Date.now();
  while (Date.now() - t0 < RUN_TIMEOUT_MS) {
    const conv = await ok(`/conversations/${id}`);
    if (['done', 'failed', 'stopped', 'waiting_approval'].includes(conv.status))
      return conv;
    await sleep(3000);
  }
  throw new Error('会话运行超时');
}

const RESULT_FILE = `e2e-${NONCE}/sum.txt`;
// execute 只锚定 cwd、不做虚拟路径映射（既有行为）：提示里明确用相对路径，
// 否则模型可能把 /xxx 当真实根目录写（权限不足或写到工作区外）。
const PROMPT =
  `请用 execute 工具在沙箱里执行这条命令（execute 默认就在工作目录执行，路径用相对路径）：` +
  `mkdir -p e2e-${NONCE} && python3 -c "print(sum(range(1, 101)))" > ${RESULT_FILE} && cat ${RESULT_FILE}` +
  `。执行完简短回复计算结果。不需要向我确认，直接执行。`;

let convId = '';
let conv = null;

await step('登录测试账号', login);

await step(
  `设置页（/settings/sandbox）切换提供方 → ${EXPECT_PROVIDER}，闲置 ${IDLE_MINUTES} 分钟`,
  async () => {
    // 与 /settings/sandbox 页面发出的请求一致：非法值被 DTO 拒绝
    for (const body of [
      { provider: 'docker' },
      { idleMinutes: 0 },
      { autoDeleteMinutes: 0 },
    ]) {
      const bad = await call('/sandbox/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      assert.equal(bad.status, 400, `应拒绝 ${JSON.stringify(body)}`);
    }
    const r = await ok('/sandbox/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        provider: EXPECT_PROVIDER,
        idleMinutes: IDLE_MINUTES,
      }),
    });
    assert.equal(r.current, EXPECT_PROVIDER);
    assert.equal(r.preference, EXPECT_PROVIDER);
    assert.equal(r.lifecycle.idleMinutes, IDLE_MINUTES);
    const again = await ok('/sandbox/settings');
    assert.equal(again.current, EXPECT_PROVIDER);
    return `default=${r.default} providers=${r.providers.map((p) => `${p.name}:${p.configured ? 'on' : 'off'}`).join(',')}`;
  },
);
await step('新建会话并运行（agent 在沙箱里执行 python）', async () => {
  const r = await ok('/conversations', {
    method: 'POST',
    body: JSON.stringify({ goal: PROMPT, model: MODEL }),
  });
  convId = r.conversationId;
  conv = await waitDone(convId);
  const err = conv.messages.find((m) => m.type === 'error');
  assert.equal(
    conv.status,
    'done',
    `会话状态 ${conv.status} ${err ? JSON.stringify(err.content).slice(0, 200) : ''}`,
  );
  return `conversation=${convId}`;
});

await step('工具调用：用了 execute，且输出含 5050、无真实路径', async () => {
  // 消息结构（agent.processor 落库）：tool_start.content.tool_calls[].name / tool_end.content.content
  const names = conv.messages
    .filter((m) => m.type === 'tool_start')
    .flatMap((m) => (m.content?.tool_calls ?? []).map((c) => c.name));
  const outputs = conv.messages
    .filter((m) => m.type === 'tool_end')
    .map((m) => String(m.content?.content ?? ''));
  assert.ok(names.includes('execute'), `工具调用：${names.join(',')}`);
  assert.ok(
    outputs.some((o) => o.includes('5050')),
    JSON.stringify(outputs),
  );
  assert.ok(
    !outputs.join('\n').includes('/agent-workspace'),
    '工具结果泄露了真实路径',
  );
  return names.join(' → ');
});

await step('助手回复里给出 5050', async () => {
  const text = conv.messages
    .filter((m) => m.role === 'assistant' && m.type === 'message')
    .map((m) => m.content?.text ?? '')
    .join('\n');
  assert.match(text, /5050/);
});

await step(`沙箱状态接口：provider=${EXPECT_PROVIDER}、运行中`, async () => {
  const s = await ok('/sandbox/status?files=1');
  assert.equal(s.exists, true);
  assert.equal(s.provider, EXPECT_PROVIDER);
  assert.equal(s.state, 'started');
  // Daytona：连接时已把远端 autoStopInterval 同步为设置值；E2B：状态接口回退用设置值
  assert.equal(s.autoStopMinutes, IDLE_MINUTES, '闲置时长设置未生效');
  assert.ok(
    s.files.some((f) => f.path === RESULT_FILE),
    `文件列表：${JSON.stringify(s.files)}`,
  );
  return `id=${s.id} desktopSupported=${s.desktopSupported}`;
});

await step('目录树与文件预览接口', async () => {
  const dir = await ok(`/sandbox/dir?path=e2e-${NONCE}`);
  assert.deepEqual(
    dir.entries.map((e) => e.name),
    ['sum.txt'],
  );
  const pv = await ok(`/sandbox/file?path=${encodeURIComponent(RESULT_FILE)}`);
  assert.equal(pv.kind, 'text');
  assert.match(pv.content, /5050/);
});

await step('会话文件列表与下载接口', async () => {
  const list = await ok(`/conversations/${convId}/files`);
  assert.ok(list.files.some((f) => f.path === RESULT_FILE));
  const dl = await ok(
    `/conversations/${convId}/files/download?path=${encodeURIComponent(RESULT_FILE)}`,
  );
  const text = Buffer.from(dl.contentBase64, 'base64').toString('utf8').trim();
  assert.equal(text, '5050');
});

if (EXPECT_PROVIDER === 'e2b') {
  await step('E2B 不支持桌面：POST /sandbox/desktop → 409', async () => {
    const r = await call('/sandbox/desktop', { method: 'POST' });
    assert.equal(r.status, 409);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (convId) console.log(`conversation=${convId}`);
process.exit(failed.length > 0 ? 1 : 0);
