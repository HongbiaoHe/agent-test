#!/usr/bin/env node
/**
 * 画布技能端到端测试：真实后端（localhost:3101）+ 真实画布模型 + 真实 socket 审批回路。
 *
 * 前置：pnpm dev 已起（后端 3101），本地未配 RESEND_API_KEY（验证码直接随响应返回），
 * 用专用测试账号登录，不碰任何真实用户的数据。会真实调用画布模型（Gemini）若干轮；
 * 所有生成（generate_media_node）都在审批里拒掉，不会产生生图/生视频。
 *
 * 运行：pnpm --filter backend test:e2e:canvas-skills
 * （经 tsx 加载：审批决策直接用前端 _lib/ask-decisions.ts 的 buildDecisions，与界面上点按钮发出的一字不差）
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// socket.io-client 只装在前端包里
const require = createRequire(
  new URL('../../frontend/package.json', import.meta.url),
);
const { io } = require('socket.io-client');
// 前端包不是 "type": "module"，tsx 按 CJS 加载它：具名导出挂在 default 上
const decisionsModule = await import(
  '../../frontend/src/app/canvas/_lib/ask-decisions.ts'
);
const { buildDecisions } = decisionsModule.default ?? decisionsModule;

/** 用户在审批卡片上点「取消」时，界面实际发出的那条决策 */
const uiReject = (tool) =>
  buildDecisions([{ tool, label: '' }], { kind: 'reject' })[0];

const API = process.env.E2E_API ?? 'http://localhost:3101';
const EMAIL = 'e2e-canvas-skills@example.test';
const SKILL = `e2e-teaser-${Date.now().toString(36).slice(-4)}`;
const RUN_TIMEOUT_MS = 8 * 60_000;

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note, ms: Date.now() - t0 });
    console.log(`✅ ${name}${note ? ` — ${note}` : ''}`);
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
    // 60s 发送频率限制：等一轮再试
    await sleep(61_000);
  }
  throw new Error('拿不到验证码：确认本地没有配置 RESEND_API_KEY');
}

/** 订阅会话事件；审批按 decide(actionRequests) 的返回值作答 */
function watch(sessionId, decide) {
  const socket = io(`${API}/canvas`, {
    transports: ['websocket'],
    extraHeaders: { Authorization: `Bearer ${token}` },
  });
  const events = [];
  socket.on('connect', () =>
    socket.emit('canvas:subscribe', { sessionId }),
  );
  socket.on('canvas:event', (evt) => {
    events.push(evt);
    if (evt.type === 'control_request') {
      const reqs = evt.payload?.actionRequests ?? [];
      const decisions = reqs.map((r) => decide(r));
      socket.emit('canvas:control:response', { sessionId, decisions });
    }
  });
  return { events, close: () => socket.close() };
}

/** 默认审批策略：保存技能放行；生成/清空一律拒（不花生成费用）；提问让它自己定 */
function defaultDecide(r) {
  if (r.name === 'save_skill') return { type: 'approve' };
  return {
    type: 'reject',
    message:
      r.name === 'ask_user'
        ? '信息已经给全了，不要再问，按你的最佳判断继续。'
        : '这次先不执行这个操作（测试环境），保持现状，直接给出总结。',
  };
}

async function waitIdle(sessionId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  // 先等它离开 queued，再等到终态
  while (Date.now() < deadline) {
    const s = await ok(`/canvas/${sessionId}`);
    if (['done', 'failed', 'stopped', 'idle'].includes(s.status)) return s;
    await sleep(2000);
  }
  throw new Error(`会话 ${sessionId} 超时未结束`);
}

async function runSession(goal, decide = defaultDecide) {
  const { sessionId } = await ok('/canvas', {
    method: 'POST',
    body: JSON.stringify({ goal, approvalMode: 'review' }),
  });
  // 先挂上 socket 再等：审批事件要靠它作答
  const w = watch(sessionId, decide);
  await sleep(300);
  const s = await waitIdle(sessionId);
  w.close();
  const messages = await ok(`/canvas/${sessionId}/messages`);
  return { sessionId, status: s.status, events: w.events, messages };
}

async function followUp(sessionId, content, decide = defaultDecide) {
  const w = watch(sessionId, decide);
  await sleep(300);
  await ok(`/canvas/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, approvalMode: 'review' }),
  });
  await sleep(1500);
  const s = await waitIdle(sessionId);
  w.close();
  return { status: s.status, messages: await ok(`/canvas/${sessionId}/messages`) };
}

const toolCalls = (messages, name) =>
  messages
    .filter((m) => m.type === 'tool_start')
    .flatMap((m) => m.content?.tool_calls ?? [])
    .filter((c) => c.name === name);
const toolEnds = (messages, name) =>
  messages.filter((m) => m.type === 'tool_end' && m.content?.name === name);
const ofType = (messages, type) => messages.filter((m) => m.type === type);

// ─────────────────────────────────────────────────────────────────────────────

await step('登录测试账号', async () => {
  await login();
  return EMAIL;
});

await step('列表里有内置 skills-creator', async () => {
  const list = await ok('/canvas-skills');
  const creator = list.find((s) => s.name === 'skills-creator');
  assert.ok(creator, JSON.stringify(list));
  assert.equal(creator.kind, 'builtin');
  assert.equal(creator.enabled, true);
  const d = await ok('/canvas-skills/skills-creator');
  assert.ok(d.files.includes('references/canvas-capabilities.md'), d.files);
  return `${list.length} 个技能`;
});

await step('内置技能不能删除、不能停用（403）', async () => {
  const del = await call('/canvas-skills/skills-creator', { method: 'DELETE' });
  assert.equal(del.status, 403);
  assert.equal(del.code, 70010);
  const off = await call('/canvas-skills/skills-creator', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(off.status, 403);
});

let sessionA;
await step('/skills-creator 显式调用 → agent 写出并保存新技能（审批放行）', async () => {
  sessionA = await runSession(
    `/skills-creator 帮我创建一个技能，name 用 ${SKILL}，用途：把一款产品做成两个镜头的预告短片（每个镜头先 image_gen 出关键帧，再 video_gen 成片，最后 video_concat 拼接），风格是暖色电影感。信息已经齐全，不要再问我，直接写好并保存。`,
  );
  const m = sessionA.messages;
  assert.equal(sessionA.status, 'done', `status=${sessionA.status}`);
  const listing = ofType(m, 'skills_listing');
  assert.equal(listing.length, 1, '首轮应落一份技能清单');
  assert.equal(listing[0].role, 'user');
  assert.match(listing[0].content.text, /skills-creator/);
  const inv = ofType(m, 'skill_invocation');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].content.name, 'skills-creator');
  assert.match(inv[0].content.text, /^## 已调用技能：skills-creator/);
  // 清单与调用排在用户消息之后
  const userSeq = m.find((x) => x.role === 'user' && x.type === 'message').seq;
  assert.ok(listing[0].seq > userSeq && inv[0].seq > listing[0].seq);
  // 审批：save_skill 走了 control_request，被放行后保存成功
  const asked = sessionA.events.some(
    (e) =>
      e.type === 'control_request' &&
      e.payload?.actionRequests?.some((r) => r.name === 'save_skill'),
  );
  assert.ok(asked, '应出现 save_skill 的审批请求');
  const saved = toolEnds(m, 'save_skill').map((e) => JSON.parse(e.content.content));
  assert.ok(saved.some((r) => r.ok && r.name === SKILL), JSON.stringify(saved));
  // 前端实时事件里有 skill_invocation（用于显示 Using skill）
  return `seq: user=${userSeq} listing=${listing[0].seq} invocation=${inv[0].seq}`;
});

await step('新技能出现在列表里，内容是规范的 SKILL.md', async () => {
  const list = await ok('/canvas-skills');
  const mine = list.find((s) => s.name === SKILL);
  assert.ok(mine, JSON.stringify(list.map((s) => s.name)));
  assert.equal(mine.kind, 'user');
  assert.equal(mine.enabled, true);
  const d = await ok(`/canvas-skills/${SKILL}`);
  assert.match(d.content, new RegExp(`^---\\nname: ${SKILL}\\ndescription: `));
  assert.ok(d.content.length > 300, `正文太短：${d.content.length}`);
  return `${d.content.length} 字符`;
});

await step('缓存前缀：清单变化才追加一份新的，历史一个字不动；不变时不再注入', async () => {
  const before = sessionA.messages.map((m) => `${m.seq}|${m.type}|${JSON.stringify(m.content)}`);
  // 第 2 轮：上一轮新存了技能 → 清单变了 → 追加第 2 份
  const r2 = await followUp(sessionA.sessionId, '好的，谢谢。不需要做别的。');
  assert.equal(r2.status, 'done');
  const after2 = r2.messages.map((m) => `${m.seq}|${m.type}|${JSON.stringify(m.content)}`);
  assert.deepEqual(after2.slice(0, before.length), before, '既有历史不能变');
  const l2 = ofType(r2.messages, 'skills_listing');
  assert.equal(l2.length, 2, '清单变了应追加第 2 份');
  assert.match(l2[1].content.text, new RegExp(SKILL));
  // 第 3 轮：清单没变 → 不再写
  const r3 = await followUp(sessionA.sessionId, '收到。');
  assert.equal(r3.status, 'done');
  assert.equal(ofType(r3.messages, 'skills_listing').length, 2, '清单没变不该再注入');
  // 跨轮的首次模型调用都应命中前缀缓存：第 2 轮清单变了（追加在末尾），第 3 轮没变。
  // token-usage 的 runs 按 startedAt 倒序，这里按时间正序取
  const usage = await ok(`/canvas/${sessionA.sessionId}/token-usage`);
  const runs = [...usage.runs].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  assert.equal(runs.length, 3);
  const firstOf = (run) => [...run.calls].sort((a, b) => a.at.localeCompare(b.at))[0];
  const pct = (c) => `${c.cacheRead}/${c.input}（${Math.round((c.cacheRead / c.input) * 100)}%）`;
  const [r2first, r3first] = [firstOf(runs[1]), firstOf(runs[2])];
  assert.ok(r2first.cacheRead > 0, `第 2 轮首调未命中缓存：${JSON.stringify(r2first)}`);
  assert.ok(r3first.cacheRead > 0, `第 3 轮首调未命中缓存：${JSON.stringify(r3first)}`);
  return `首调缓存命中 第2轮 ${pct(r2first)}，第3轮 ${pct(r3first)}`;
});

await step(`/${SKILL} 调用用户自建技能 → agent 按技能搭工作流（生成被拒，不花费）`, async () => {
  const r = await runSession(`/${SKILL} 产品：一款白色无线降噪耳机`);
  const inv = ofType(r.messages, 'skill_invocation');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].content.name, SKILL);
  const detail = await ok(`/canvas-skills/${SKILL}`);
  const bodyLine = detail.content.split('\n').find((l) => l.startsWith('#'));
  assert.ok(inv[0].content.text.includes(bodyLine), '调用消息应含 SKILL.md 正文');
  // 技能是 agent 自己写的，分不分阶段每次不一样：写成「先出关键帧、等出图再建视频节点」时，
  // 关键帧生成被拒后就该停在第一阶段。所以只断言它照技能动手了：建了关键帧并尝试触发生成
  const adds = toolCalls(r.messages, 'add_node');
  const types = adds.map((c) => c.args?.type);
  assert.ok(types.includes('image_gen'), JSON.stringify(types));
  assert.ok(
    r.events.some(
      (e) =>
        e.type === 'control_request' &&
        e.payload?.actionRequests?.some((q) => q.name === 'generate_media_node'),
    ),
    '应照技能触发生成（审批里被拒）',
  );
  // 不该再 read_file 读一遍被调用的 SKILL.md（全文已给）
  const reread = toolCalls(r.messages, 'read_file').filter(
    (c) => c.args?.file_path === `/skills/${SKILL}/SKILL.md`,
  );
  return `建了 ${adds.length} 个节点（${types.join(',')}）；重读 SKILL.md ${reread.length} 次；status=${r.status}`;
});

await step('不用 / 时 agent 自己按清单 read_file 加载 skills-creator（progressive disclosure）', async () => {
  const r = await runSession(
    '我经常做「三个镜头的美食短视频」，想把这套做法沉淀成一个可复用的技能，帮我弄一下。信息就这些，别问我，直接写。',
    (req) =>
      req.name === 'save_skill' ? uiReject('save_skill') : defaultDecide(req),
  );
  assert.equal(ofType(r.messages, 'skill_invocation').length, 0, '没有 / 不该注入全文');
  const reads = toolCalls(r.messages, 'read_file').map((c) => c.args?.file_path);
  assert.ok(
    reads.includes('/skills/skills-creator/SKILL.md'),
    `应自己读 skills-creator：${JSON.stringify(reads)}`,
  );
  // read_file 的结果是内容块数组（[{text}]），不是字符串
  const ends = toolEnds(r.messages, 'read_file');
  assert.ok(
    ends.some(
      (e) =>
        e.content.status === 'success' &&
        JSON.stringify(e.content.content).includes('name: skills-creator'),
    ),
    '读到的应是技能正文而不是报错',
  );
  // 保存被拒后不能谎称已保存
  const final = r.messages.filter((m) => m.type === 'message' && m.role === 'assistant').at(-1);
  const claims = /(已经?(为你)?(保存|创建好|配置好|建好)了?(这个|该)?(新)?技能)/.test(final?.content?.text ?? '');
  assert.ok(!claims, `被拒后仍声称已保存：${final?.content?.text?.slice(0, 120)}`);
  const list = await ok('/canvas-skills');
  assert.ok(!list.some((s) => s.kind === 'user' && s.name.includes('food')), '被拒的技能不该落库');
  return `read_file: ${reads.join(', ')}`;
});

await step('停用用户技能 → 清单与调用都不再包含它；再启用', async () => {
  await ok(`/canvas-skills/${SKILL}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  const list = await ok('/canvas-skills');
  assert.equal(list.find((s) => s.name === SKILL).enabled, false);
  const r = await runSession(`/${SKILL} 测试`);
  assert.equal(ofType(r.messages, 'skill_invocation').length, 0, '停用的技能不能被调用');
  const listing = ofType(r.messages, 'skills_listing')[0].content.text;
  assert.ok(!listing.includes(SKILL), '停用的技能不该出现在清单里');
  await ok(`/canvas-skills/${SKILL}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true }),
  });
});

await step('删除用户技能 → 之后 404', async () => {
  await ok(`/canvas-skills/${SKILL}`, { method: 'DELETE' });
  const d = await call(`/canvas-skills/${SKILL}`);
  assert.equal(d.status, 404);
  assert.equal(d.code, 70009);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
