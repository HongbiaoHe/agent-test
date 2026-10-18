#!/usr/bin/env node
/**
 * Spark agent × 生图/生视频 端到端测试：真实后端 + 真实对话模型 + 真实 aigc 生成。
 *
 * 前置：后端已起（缺省 localhost:3101），本地未配 RESEND_API_KEY（验证码随响应返回），
 * AIGC_BASE_URL / AIGC_TOKEN 可用。会产生真实生成费用（3 张低档图 + 1 段 8 秒视频 + 1 张被取消的图）。
 *
 * 用专用测试账号逐个场景各开一个会话，先订阅 socket 再发消息，核对：
 *  1. 参数校验回馈：模型传了非法取值 → 工具返回 invalid_params（带 allowed）→ 模型改参重试成功；
 *  2. 异步状态推送：media_update 依次推 queued → generating → done（或 cancelled），与 REST 终态一致；
 *  3. 批量：用户明确要 3 张 → 一次调用 count=3 → 3 个独立生成位全部完成；
 *  4. 生视频：违反模型约束（veo 1080p 只许 8 秒）→ 被拒后改正，产物为 mp4；
 *  5. 取消：生成中点停止 → 推 cancelled，版本终态 cancelled。
 *
 * 运行（apps/backend 下）：pnpm test:e2e:spark-media
 * 环境变量：E2E_API（缺省 http://localhost:3101）；E2E_MODEL（回答模型，缺省走后端默认，
 * 须在 ALLOWED_MODELS 白名单内）；E2E_CASES（逗号分隔，缺省 image,batch,video,cancel）。
 */
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const API = process.env.E2E_API ?? 'http://localhost:3101';
const MODEL = process.env.E2E_MODEL;
const CASES = (process.env.E2E_CASES ?? 'image,batch,video,cancel').split(',');
const EMAIL = 'e2e-spark-media@example.test';
const RUN_TIMEOUT_MS = 3 * 60_000;
const IMAGE_TIMEOUT_MS = 5 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const OPEN = ['queued', 'generating'];

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

/**
 * 一个场景 = 一个新会话：先建空会话并订阅 socket（只推订阅之后的事件），再发消息。
 * 返回 { convId, mediaEvents, stop() }；mediaEvents 实时累积 media_update 的 payload。
 */
async function openConversation() {
  const { conversationId } = await ok('/conversations', {
    method: 'POST',
    body: JSON.stringify(MODEL ? { model: MODEL } : {}),
  });
  const socket = io(API, {
    transports: ['websocket'],
    extraHeaders: { authorization: `Bearer ${token}` },
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const ack = await socket.emitWithAck('conversation:subscribe', {
    conversationId,
  });
  assert.equal(ack?.ok, true, `订阅失败 ${JSON.stringify(ack)}`);
  const mediaEvents = [];
  const listeners = [];
  socket.onAny((_ev, e) => {
    if (e?.type !== 'media_update') return;
    mediaEvents.push(e.payload);
    for (const fn of listeners) fn(e.payload);
  });
  return {
    convId: conversationId,
    mediaEvents,
    onMedia: (fn) => listeners.push(fn),
    close: () => socket.close(),
  };
}

async function send(convId, content) {
  await ok(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, ...(MODEL ? { model: MODEL } : {}) }),
  });
}

/** 等本轮 agent 跑完（done/stopped），返回会话（含 messages）。 */
async function waitRun(convId) {
  const t0 = Date.now();
  await sleep(2000);
  while (Date.now() - t0 < RUN_TIMEOUT_MS) {
    const conv = await ok(`/conversations/${convId}`);
    if (['done', 'failed', 'stopped', 'waiting_approval'].includes(conv.status))
      return conv;
    await sleep(2000);
  }
  throw new Error('会话运行超时');
}

/** 等会话下所有媒体版本离开 queued/generating，返回 GET /conversations/:id/media。 */
async function waitMedia(convId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const media = await ok(`/conversations/${convId}/media`);
    const versions = media.flatMap((g) => g.versions);
    if (versions.length > 0 && versions.every((v) => !OPEN.includes(v.status)))
      return media;
    await sleep(3000);
  }
  throw new Error('媒体生成超时');
}

/** 消息表里某工具的全部调用参数与结果（agent.processor 落库结构）。 */
function toolTrace(conv, name) {
  const calls = conv.messages
    .filter((m) => m.type === 'tool_start')
    .flatMap((m) => m.content?.tool_calls ?? [])
    .filter((c) => c.name === name);
  const outputs = conv.messages
    .filter((m) => m.type === 'tool_end' && m.content?.name === name)
    .map((m) => JSON.parse(String(m.content?.content ?? '{}')));
  return { calls, outputs };
}

/** 某版本收到的 media_update 状态序列（去掉相邻重复）。 */
function statusSeq(events, versionId) {
  return events
    .filter((e) => e.versionId === versionId)
    .map((e) => e.status)
    .filter((s, i, a) => s !== a[i - 1]);
}

function assertPushed(events, versionId, final) {
  const seq = statusSeq(events, versionId);
  assert.deepEqual(
    seq,
    ['queued', 'generating', final],
    `版本 ${versionId} 推送序列 ${seq.join('→')}`,
  );
}

/** 断言：先被 invalid_params 拒（含该字段与 allowed），之后有一次 queued 成功。返回成功的那次结果。 */
function assertCorrected(trace, field, allowedIncludes) {
  const rejectedAt = trace.outputs.findIndex(
    (o) => o.error === 'invalid_params',
  );
  assert.ok(
    rejectedAt >= 0,
    `没有触发参数校验：${JSON.stringify(trace.outputs)}`,
  );
  const issue = trace.outputs[rejectedAt].issues.find((i) => i.field === field);
  assert.ok(
    issue,
    `issues 里没有 ${field}：${JSON.stringify(trace.outputs[rejectedAt])}`,
  );
  assert.ok(
    issue.allowed?.includes(allowedIncludes),
    `allowed 应含 ${allowedIncludes}：${JSON.stringify(issue)}`,
  );
  const success = trace.outputs
    .slice(rejectedAt + 1)
    .find((o) => o.status === 'queued');
  assert.ok(
    success,
    `被拒后没有改参重试成功：${JSON.stringify(trace.outputs)}`,
  );
  return { issue, success };
}

await step('登录测试账号', login);

if (CASES.includes('image')) {
  await step(
    '单张生图：非法比例被拒 → 改参重试 → 推送 queued→generating→done',
    async () => {
      const c = await openConversation();
      try {
        // gpt-image-2 的画幅写法是 16x9；要求模型直接按用户原话调用，才能确定走到校验回馈这条路
        await send(
          c.convId,
          '用 gpt-image-2 生成一张比例 16:9、清晰度 low 的图：一只橘猫坐在窗台上看雨，水彩风格。提示词就用这句，我已确认，请直接调用 generate_image 生成，不用先查模型列表，只要 1 张。',
        );
        const conv = await waitRun(c.convId);
        assert.equal(conv.status, 'done', `会话状态 ${conv.status}`);
        const trace = toolTrace(conv, 'generate_image');
        const { success } = assertCorrected(
          trace,
          'params.aspect_ratio',
          '16x9',
        );
        assert.equal(success.model, 'gpt-image-2');
        assert.equal(success.params.aspect_ratio, '16x9');
        assert.equal(
          success.generations.length,
          1,
          '未要求多张时应只生成 1 个',
        );

        const media = await waitMedia(c.convId, IMAGE_TIMEOUT_MS);
        const v = media[0].versions[0];
        assert.equal(v.status, 'done', `终态 ${v.status} ${v.error ?? ''}`);
        assert.ok(v.filePath, '缺少产物文件');
        assertPushed(c.mediaEvents, v.id, 'done');
        return `conversation=${c.convId} ${trace.outputs.length} 次调用`;
      } finally {
        c.close();
      }
    },
  );
}

if (CASES.includes('batch')) {
  await step(
    '批量：明确要 3 张 → count=3 → 3 个生成位各自推送并完成',
    async () => {
      const c = await openConversation();
      try {
        await send(
          c.convId,
          '用 nano-banana-2-lite 生成 3 张图，比例 1:1，提示词：极简线条风格的咖啡店 logo，一只咖啡杯冒着心形热气，米色背景。我已确认，直接生成这 3 张。',
        );
        const conv = await waitRun(c.convId);
        assert.equal(conv.status, 'done', `会话状态 ${conv.status}`);
        const trace = toolTrace(conv, 'generate_image');
        const success = trace.outputs.find((o) => o.status === 'queued');
        assert.ok(success, JSON.stringify(trace.outputs));
        assert.equal(success.generations.length, 3);
        assert.ok(
          trace.calls.some((call) => call.args?.count === 3),
          `调用参数：${JSON.stringify(trace.calls.map((x) => x.args))}`,
        );

        const media = await waitMedia(c.convId, IMAGE_TIMEOUT_MS);
        assert.equal(media.length, 3);
        for (const g of media) {
          const v = g.versions[0];
          assert.equal(v.status, 'done', `终态 ${v.status} ${v.error ?? ''}`);
          assertPushed(c.mediaEvents, v.id, 'done');
        }
        return `conversation=${c.convId}`;
      } finally {
        c.close();
      }
    },
  );
}

if (CASES.includes('video')) {
  await step(
    '生视频：违反约束（veo 1080p 只许 8 秒）被拒 → 改为 8 秒 → 完成 mp4',
    async () => {
      const c = await openConversation();
      try {
        await send(
          c.convId,
          '用 veo-3.1-fast 生成一段视频：1080p、16:9、时长 4 秒，提示词：海浪拍打黑色礁石的慢镜头，夕阳逆光，水花飞溅。我已确认，请直接调用 generate_video，不用先查模型列表，只要 1 段。',
        );
        const conv = await waitRun(c.convId);
        assert.equal(conv.status, 'done', `会话状态 ${conv.status}`);
        const trace = toolTrace(conv, 'generate_video');
        const { success } = assertCorrected(trace, 'params.duration', '8');
        assert.equal(success.params.duration, '8');
        assert.equal(success.params.resolution, '1080p');

        const media = await waitMedia(c.convId, VIDEO_TIMEOUT_MS);
        const v = media[0].versions[0];
        assert.equal(v.status, 'done', `终态 ${v.status} ${v.error ?? ''}`);
        assert.match(v.filePath ?? '', /\.mp4$/);
        assertPushed(c.mediaEvents, v.id, 'done');
        return `conversation=${c.convId}`;
      } finally {
        c.close();
      }
    },
  );
}

if (CASES.includes('cancel')) {
  await step(
    '取消：生成中点停止 → 推送 cancelled，版本终态 cancelled',
    async () => {
      const c = await openConversation();
      try {
        // 首次进入 generating 立刻停止：覆盖「提交 aigc 的 HTTP 调用期间被停止」这个窗口
        let stopped = null;
        c.onMedia((p) => {
          if (p.status === 'generating' && !stopped) {
            stopped = ok(`/conversations/${c.convId}/stop`, {
              method: 'POST',
              body: '{}',
            });
          }
        });
        await send(
          c.convId,
          '用 nano-banana-2-lite 生成 1 张图，比例 1:1，提示词：一只柴犬戴着墨镜。我已确认，直接生成。',
        );
        await waitRun(c.convId);
        assert.ok(stopped, '没等到 generating 推送，未能触发停止');
        await stopped;
        const media = await waitMedia(c.convId, IMAGE_TIMEOUT_MS);
        const v = media[0].versions[0];
        assert.equal(v.status, 'cancelled', `终态 ${v.status}`);
        assert.equal(v.error, '用户已停止');
        assertPushed(c.mediaEvents, v.id, 'cancelled');
        return `conversation=${c.convId}`;
      } finally {
        c.close();
      }
    },
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
