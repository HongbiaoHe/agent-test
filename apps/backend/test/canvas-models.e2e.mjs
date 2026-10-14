#!/usr/bin/env node
/**
 * 画布 agent 模型冒烟测试：真实后端（localhost:3101）+ 真实模型。
 *
 * 对每个模型建一个独立画布会话（review 审批模式），让 agent 用 add_node / connect_nodes
 * 搭两节点工作流（明确不触发生成，生成类工具本就需要审批，不会产生费用）；第二轮让它改
 * 一个节点的提示词，用第二轮的 cacheRead / input 量提示缓存命中率。
 *
 * 前置：本地未配 RESEND_API_KEY（验证码随响应返回）。用专用测试账号，不碰真实用户数据。
 * 运行（apps/backend 下）：E2E_CANVAS_MODELS=gemini-3.8-flash,gemini-4-argon node test/canvas-models.e2e.mjs
 */
import assert from 'node:assert/strict';

const API = process.env.E2E_API ?? 'http://localhost:3101';
const EMAIL = 'e2e-canvas-models@example.test';
const MODELS = (
  process.env.E2E_CANVAS_MODELS ?? 'gemini-3.8-flash,gemini-4-argon'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const RUN_TIMEOUT_MS = 5 * 60_000;

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

let token = '';
async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    if (sent.data?.code) {
      token = (
        await ok('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: EMAIL, code: sent.data.code }),
        })
      ).token;
      return;
    }
    await sleep(61_000); // 60s 发送频率限制
  }
  throw new Error('拿不到验证码：确认本地没有配置 RESEND_API_KEY');
}

async function waitIdle(id) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await ok(`/canvas/${id}`);
    if (
      ['done', 'failed', 'stopped', 'idle', 'waiting_approval'].includes(
        s.status,
      )
    )
      return s;
    await sleep(2000);
  }
  throw new Error('运行超时');
}

const toolNames = (messages) =>
  messages
    .filter((m) => m.type === 'tool_start')
    .flatMap((m) => m.content?.tool_calls ?? [])
    .map((c) => c.name);

await step('登录测试账号', login);

for (const model of MODELS) {
  let sessionId = '';

  await step(
    `[${model}] 第一轮：搭两节点工作流（add_node / connect_nodes）`,
    async () => {
      const r = await ok('/canvas', {
        method: 'POST',
        body: JSON.stringify({
          model,
          approvalMode: 'review',
          goal:
            '在画布上搭一个两步工作流：先添加一个图片生成节点（提示词：一只橘猫坐在窗台上，水彩风格），' +
            '再添加一个视频生成节点（提示词：橘猫转头看向镜头），并把图片节点连到视频节点。' +
            '只搭建，不要触发任何生成，也不要向我提问。完成后用一句话总结。',
        }),
      });
      sessionId = r.sessionId;
      const s = await waitIdle(sessionId);
      const messages = await ok(`/canvas/${sessionId}/messages`);
      const names = toolNames(messages);
      const err = messages.find((m) => m.type === 'error');
      assert.equal(
        s.status,
        'done',
        `状态 ${s.status} ${err ? JSON.stringify(err.content).slice(0, 200) : ''}`,
      );
      assert.ok(names.includes('add_node'), `工具调用：${names.join(',')}`);
      assert.ok(
        names.includes('connect_nodes'),
        `工具调用：${names.join(',')}`,
      );
      assert.ok(!names.includes('generate_media_node'), '不该触发生成');
      const snap = await ok(`/canvas/${sessionId}`);
      assert.ok(
        (snap.nodes ?? []).length >= 2,
        `节点数 ${(snap.nodes ?? []).length}`,
      );
      assert.ok(
        (snap.edges ?? []).length >= 1,
        `连线数 ${(snap.edges ?? []).length}`,
      );
      return `nodes=${snap.nodes.length} edges=${snap.edges.length} tools=${names.join('→')}`;
    },
  );

  await step(
    `[${model}] 第二轮：改节点提示词（update_node）+ 缓存命中`,
    async () => {
      assert.ok(sessionId, '第一轮未建出会话');
      await ok(`/canvas/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model,
          approvalMode: 'review',
          content:
            '把图片节点的提示词改成：一只橘猫坐在窗台上，油画风格。只改提示词，不要生成，不要提问。',
        }),
      });
      await sleep(1500);
      const s = await waitIdle(sessionId);
      assert.equal(s.status, 'done', `状态 ${s.status}`);
      const names = toolNames(await ok(`/canvas/${sessionId}/messages`));
      assert.ok(names.includes('update_node'), `工具调用：${names.join(',')}`);
      const report = await ok(`/canvas/${sessionId}/token-usage`);
      const latest = report.runs[0];
      const { input, cacheRead } = latest.totals;
      const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
      return `第二轮 input=${input} cacheRead=${cacheRead} 命中率=${hit}%`;
    },
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
