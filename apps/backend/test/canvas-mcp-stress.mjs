#!/usr/bin/env node
/**
 * 画布 MCP 对外服务的压力 / 边界测试：超多节点、并发写、乱传 id、半途断开、锁过期，
 * 重点核对「有没有误删 / 误清空」——每一步后都拿数据库与快照对账。
 *
 * 前置同 canvas-mcp-server.e2e.mjs：前端 3100 + 后端 3101，后端 CANVAS_MOCK_MEDIA_ENABLED=true。
 * 只用专用测试账号（e2e-canvas-mcp*@example.test），不碰真实用户数据；结束吊销全部临时 PAT。
 *
 * 运行：node test/canvas-mcp-stress.mjs（apps/backend 目录下）。SCALE=2000 可调大单块画布的节点量。
 */
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SITE = process.env.E2E_SITE ?? 'http://localhost:3100';
const API = process.env.E2E_API ?? 'http://localhost:3101';
const MCP_URL = new URL('/mcp', SITE);
const EMAIL = 'e2e-canvas-mcp@example.test';
const OTHER_EMAIL = 'e2e-canvas-mcp-other@example.test';
const SCALE = Number(process.env.SCALE ?? 1000);
const prisma = new PrismaClient();

const results = [];
const findings = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name}${note ? ` — ${note}` : ''} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`❌ ${name} — ${err?.stack ?? err}`);
  }
}
const finding = (s) => {
  findings.push(s);
  console.log(`   ⚠️  ${s}`);
};

async function api(jwt, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}
async function apiOk(jwt, path, init) {
  const { status, body } = await api(jwt, path, init);
  if (body.code !== 0) throw new Error(`${path} → ${status} ${JSON.stringify(body)}`);
  return body.data;
}
async function login(email) {
  const { code } = await apiOk(null, '/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const { token } = await apiOk(null, '/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
  return token;
}

const patIds = [];
async function newPat(jwt, name, scopes) {
  const r = await apiOk(jwt, '/mcp-server/grants', {
    method: 'POST',
    body: JSON.stringify({ name, scopes, expiresInDays: 30 }),
  });
  patIds.push({ jwt, id: r.grant.id });
  return r.token;
}
async function connect(token, title) {
  const client = new Client({ name: 'stress', title, version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
/** 工具调用 → { isError, json, text }；协议层错误（参数校验 / HTTP）也收成 isError */
async function call(client, name, args, opts) {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
      ...opts,
    });
    const text = r.content?.[0]?.text ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { isError: r.isError === true, json, text };
  } catch (e) {
    return { isError: true, protocol: true, json: null, text: String(e?.message ?? e) };
  }
}

/** 数据库真相：节点 / 连线数、revision、op 日志（含 clear 次数） */
async function truth(canvasId) {
  const [nodes, edges, session, ops, clears] = await Promise.all([
    prisma.canvasNode.count({ where: { sessionId: canvasId } }),
    prisma.canvasEdge.count({ where: { sessionId: canvasId } }),
    prisma.canvasSession.findUnique({
      where: { id: canvasId },
      select: { revision: true, runLockHolder: true, runLockExpiresAt: true },
    }),
    prisma.canvasOp.count({ where: { sessionId: canvasId } }),
    prisma.canvasOp.findMany({
      where: { sessionId: canvasId },
      select: { op: true, seq: true },
    }),
  ]);
  const clearOps = clears.filter((o) => o.op?.op === 'clear').length;
  const removeOps = clears.filter((o) => o.op?.op === 'remove_node').length;
  return { nodes, edges, revision: session?.revision, ops, clearOps, removeOps, session };
}

const nodeSpecs = (n, prefix, x0 = 0) =>
  Array.from({ length: n }, (_, i) => ({
    type: i % 3 === 0 ? 'image_gen' : 'image_upload',
    label: `${prefix}-${i}`,
    ...(i % 3 === 0 ? { prompt: `stress ${prefix} ${i}` } : {}),
    x: x0 + (i % 40) * 320,
    y: Math.floor(i / 40) * 360,
  }));

// ───────────────────────────────────────────────────────────────────────────
const jwt = await login(EMAIL);
const otherJwt = await login(OTHER_EMAIL);
const ALL = ['canvas:read', 'canvas:write', 'media:generate'];
const patA = await newPat(jwt, 'stress A', ALL);
const patB = await newPat(jwt, 'stress B', ALL);
const patRO = await newPat(jwt, 'stress RO', ['canvas:read']);
const patOther = await newPat(otherJwt, 'stress other', ALL);
const A = await connect(patA, 'Stress Agent A');
const B = await connect(patB, 'Stress Agent B');
const RO = await connect(patRO, 'Stress RO');
const OTHER = await connect(patOther, 'Stress Other Tenant');

// 对照画布：全程不该被任何操作波及（另一个租户的一块 + 本租户的一块）
let control = '';
let otherControl = '';
let big = '';
let baseline = {};
await step('准备：对照画布（本租户 / 另一租户各一块，各 5 个节点）', async () => {
  control = (await call(A, 'create_canvas', { title: 'stress control' })).json.canvasId;
  await call(A, 'add_nodes', { canvasId: control, nodes: nodeSpecs(5, 'ctl') });
  otherControl = (await call(OTHER, 'create_canvas', { title: 'stress other control' })).json.canvasId;
  await call(OTHER, 'add_nodes', { canvasId: otherControl, nodes: nodeSpecs(5, 'oth') });
  baseline = { control: await truth(control), other: await truth(otherControl) };
  assert.equal(baseline.control.nodes, 5);
  assert.equal(baseline.other.nodes, 5);
  // A 在 control 上持着锁；等它过期太慢，换 B 之前先让后续步骤都用新画布
});

// ── 1. 规模 ────────────────────────────────────────────────────────────────
const timing = {};
await step(`规模：add_nodes 分批建到 ${SCALE} 个节点`, async () => {
  big = (await call(A, 'create_canvas', { title: `stress ${SCALE}` })).json.canvasId;
  const batches = [10, 100, 500];
  let total = 0;
  for (const n of batches) {
    if (total + n > SCALE) break;
    const t0 = Date.now();
    const r = await call(A, 'add_nodes', { canvasId: big, nodes: nodeSpecs(n, `b${n}`) });
    assert.ok(!r.isError, r.text.slice(0, 300));
    assert.equal(r.json.created, n);
    timing[`add_nodes×${n}`] = Date.now() - t0;
    total += n;
  }
  while (total < SCALE) {
    const n = Math.min(500, SCALE - total);
    const t0 = Date.now();
    const r = await call(A, 'add_nodes', { canvasId: big, nodes: nodeSpecs(n, `f${total}`) });
    assert.equal(r.json?.created, n, r.text.slice(0, 300));
    timing[`add_nodes×${n}@${total}`] = Date.now() - t0;
    total += n;
  }
  const t = await truth(big);
  assert.equal(t.nodes, SCALE);
  assert.equal(t.revision, t.ops);
  return JSON.stringify(timing);
});

await step(`规模：${SCALE} 节点时 get_canvas 的耗时与体积`, async () => {
  const t0 = Date.now();
  const r = await call(A, 'get_canvas', { canvasId: big });
  const ms = Date.now() - t0;
  assert.ok(!r.isError, r.text.slice(0, 300));
  const bytes = Buffer.byteLength(r.text);
  const stateBytes = Buffer.byteLength(r.json.state);
  timing.get_canvas = ms;
  if (bytes > 100_000) {
    finding(
      `get_canvas 在 ${SCALE} 节点时返回 ${(bytes / 1024).toFixed(0)}KB（state ${(stateBytes / 1024).toFixed(0)}KB），约 ${Math.round(bytes / 3.5 / 1000)}k token，客户端可能截断或撑爆上下文`,
    );
  }
  return `${ms}ms，响应 ${(bytes / 1024).toFixed(0)}KB，state ${(stateBytes / 1024).toFixed(0)}KB，media ${r.json.media.length} 项`;
});

let shortIds = [];
await step(`规模：update_nodes 每批 500 改 ${Math.min(SCALE, 1000)} 个节点`, async () => {
  const rows = await prisma.canvasNode.findMany({
    where: { sessionId: big },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  shortIds = rows.map((r) => r.id.slice(-6));
  const n = Math.min(SCALE, 1000);
  const t0 = Date.now();
  let updated = 0;
  for (let i = 0; i < n; i += 500) {
    const r = await call(A, 'update_nodes', {
      canvasId: big,
      updates: shortIds.slice(i, Math.min(i + 500, n)).map((id, k) => ({ nodeId: id, label: `upd-${i + k}` })),
    });
    assert.ok(!r.isError, r.text.slice(0, 300));
    if (r.json.failed?.length) finding(`update_nodes 里 ${r.json.failed.length} 条失败：${JSON.stringify(r.json.failed.slice(0, 3))}`);
    updated += r.json.updated;
  }
  timing.update_nodes = Date.now() - t0;
  const t = await truth(big);
  assert.equal(t.nodes, SCALE, '改 label 不该增删节点');
  return `updated=${updated}，${timing.update_nodes}ms`;
});

await step('规模：6 位短 id 有没有撞车（撞了就无法寻址）', async () => {
  const dup = shortIds.length - new Set(shortIds).size;
  if (dup > 0) finding(`${shortIds.length} 个节点里有 ${dup} 个短 id 重复`);
  return `${shortIds.length} 个节点，重复 ${dup}`;
});

// ── 2. 误删 / 误清空 ─────────────────────────────────────────────────────────
await step('误删：delete_node 传空串 / 1~3 位后缀 / 不存在的 id，节点一个不少', async () => {
  const before = await truth(big);
  const probes = ['', 'a', '1', 'z9', shortIds[0].slice(-3), 'not-a-node', 'x'.repeat(5000)];
  const out = [];
  for (const id of probes) {
    const r = await call(A, 'delete_node', { canvasId: big, nodeId: id });
    out.push(`${JSON.stringify(id.slice(0, 8))}→${r.json?.error ?? r.json?.ok ?? r.text.slice(0, 40)}`);
    if (r.json?.ok) finding(`${before.nodes} 个节点的画布上 delete_node(${JSON.stringify(id)}) 删掉了一个节点：不足 6 位的后缀只要恰好唯一就会命中`);
  }
  const after = await truth(big);
  assert.equal(after.nodes, before.nodes, `节点数变了：${before.nodes} → ${after.nodes}`);
  return out.join('；');
});

await step('误删：节点唯一时 delete_node 传空串 / 1 位后缀', async () => {
  const solo = (await call(A, 'create_canvas', { title: 'stress solo' })).json.canvasId;
  const add = await call(A, 'add_node', { canvasId: solo, type: 'image_upload', x: 0, y: 0 });
  const full = (await prisma.canvasNode.findFirst({ where: { sessionId: solo } })).id;
  const r1 = await call(A, 'delete_node', { canvasId: solo, nodeId: '' });
  const n1 = (await truth(solo)).nodes;
  if (n1 === 0) {
    finding(`delete_node 传空串 nodeId 会删掉画布上唯一的节点（resolveNodeIdIn 后缀匹配 "" 命中全部；节点 ${add.json.nodeId}）`);
    await call(A, 'add_node', { canvasId: solo, type: 'image_upload', x: 0, y: 0 });
  }
  const one = (await prisma.canvasNode.findFirst({ where: { sessionId: solo } })).id.slice(-1);
  const r2 = await call(A, 'delete_node', { canvasId: solo, nodeId: one });
  const n2 = (await truth(solo)).nodes;
  if (n2 === 0) finding(`delete_node 传 1 位后缀 "${one}" 也会删掉唯一的节点（后缀匹配不设最短长度）`);
  await call(A, 'clear_canvas', { canvasId: solo });
  return `空串→${r1.text.slice(0, 50)}（剩 ${n1}）；1 位→${r2.text.slice(0, 50)}（剩 ${n2}）；full=${full.slice(-6)}`;
});

await step('误清空：clear_canvas 打到别的租户 / 不存在 / 空 canvasId，全部拒绝', async () => {
  const cases = [otherControl, 'nonexistent-canvas', '', ' ', '%'];
  const out = [];
  for (const id of cases) {
    const r = await call(A, 'clear_canvas', { canvasId: id });
    assert.ok(r.isError, `clear_canvas(${JSON.stringify(id)}) 应被拒：${r.text}`);
    out.push(`${JSON.stringify(id.slice(0, 10))}→${r.protocol ? 'schema 拒绝' : r.text.slice(0, 40)}`);
  }
  const o = await truth(otherControl);
  assert.equal(o.nodes, 5);
  assert.equal(o.clearOps, 0);
  return out.join('；');
});

await step('误清空：只读 PAT 看不到 clear_canvas / delete_node，硬调也被拒', async () => {
  const names = (await RO.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('clear_canvas') && !names.includes('delete_node'));
  const r = await call(RO, 'clear_canvas', { canvasId: big });
  assert.ok(r.isError);
  assert.equal((await truth(big)).nodes, SCALE);
  return r.text.slice(0, 80);
});

await step('误清空：别的 agent（B）在 A 持锁时 clear_canvas / delete_node → CANVAS_BUSY', async () => {
  const before = await truth(big);
  await call(A, 'update_node', { canvasId: big, nodeId: shortIds[0], label: 'renew' }); // 续锁
  const c = await call(B, 'clear_canvas', { canvasId: big });
  const d = await call(B, 'delete_node', { canvasId: big, nodeId: shortIds[1] });
  assert.ok(c.isError && c.text.includes('70003'), c.text); // CANVAS_BUSY
  assert.ok(d.isError, d.text);
  const after = await truth(big);
  assert.equal(after.nodes, before.nodes);
  assert.equal(after.clearOps, 0);
  return c.text.slice(0, 80);
});

await step('误清空：网页用户在 MCP 持锁时 POST /ops clear → 拒绝', async () => {
  const before = await truth(big);
  const r = await api(jwt, `/canvas/${big}/ops`, {
    method: 'POST',
    body: JSON.stringify({ baseRevision: before.revision, op: { op: 'clear' } }),
  });
  assert.notEqual(r.body.code, 0, `用户 clear 竟然成功：${JSON.stringify(r.body)}`);
  const after = await truth(big);
  assert.equal(after.nodes, before.nodes);
  return `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`;
});

// ── 3. 并发 ──────────────────────────────────────────────────────────────
await step('并发：同一授权 20 路并行 add_nodes×10 → 不丢不重，revision 与 op 日志一致', async () => {
  const before = await truth(big);
  const rs = await Promise.all(
    Array.from({ length: 20 }, (_, k) =>
      call(A, 'add_nodes', { canvasId: big, nodes: nodeSpecs(10, `par${k}`, 20000) }),
    ),
  );
  const created = rs.reduce((s, r) => s + (r.json?.created ?? 0), 0);
  const errs = rs.filter((r) => r.isError).map((r) => r.text.slice(0, 80));
  const after = await truth(big);
  assert.equal(after.nodes - before.nodes, created, '库里新增数与工具回报不一致');
  assert.equal(after.revision, after.ops, 'revision 与 op 日志条数不一致');
  if (created !== 200) finding(`20 路并行 add_nodes 只成功 ${created}/200：${errs.join(' | ')}`);
  return `新增 ${created}，revision ${before.revision}→${after.revision}`;
});

await step('并发：并行删 50 + 改 50 + 连线 50（互不相交），只删该删的', async () => {
  const before = await truth(big);
  const pool = shortIds.slice(100, 300);
  const del = pool.slice(0, 50);
  const upd = pool.slice(50, 100);
  const src = pool.slice(100, 150);
  const dst = pool.slice(150, 200);
  const rs = await Promise.all([
    ...del.map((id) => call(A, 'delete_node', { canvasId: big, nodeId: id })),
    call(A, 'update_nodes', { canvasId: big, updates: upd.map((id) => ({ nodeId: id, x: 99999 })) }),
    ...src.map((s, i) => call(A, 'connect_nodes', { canvasId: big, sourceId: s, targetId: dst[i] })),
  ]);
  const after = await truth(big);
  const removed = before.nodes - after.nodes;
  const errs = rs.filter((r) => r.isError || r.json?.error).map((r) => r.text.slice(0, 60));
  assert.equal(removed, 50, `应删 50，实删 ${removed}`);
  // 被删的确实是 del 里那 50 个
  const left = await prisma.canvasNode.findMany({ where: { sessionId: big }, select: { id: true } });
  const leftShort = new Set(left.map((n) => n.id.slice(-6)));
  assert.ok(del.every((d) => !leftShort.has(d)));
  assert.ok([...upd, ...src, ...dst].every((d) => leftShort.has(d)), '误删了不该删的节点');
  return `删 ${removed}，新连线 ${after.edges - before.edges}，失败 ${errs.length}${errs.length ? `：${[...new Set(errs)].slice(0, 2).join(' | ')}` : ''}`;
});

await step('并发：A、B 抢同一块空闲画布，只有一方写得进去', async () => {
  const c = (await call(A, 'create_canvas', { title: 'stress race' })).json.canvasId;
  // create_canvas 不上锁；两边同时第一次写
  const [ra, rb] = await Promise.all([
    call(A, 'add_nodes', { canvasId: c, nodes: nodeSpecs(20, 'ra') }),
    call(B, 'add_nodes', { canvasId: c, nodes: nodeSpecs(20, 'rb') }),
  ]);
  const t = await truth(c);
  const winners = [ra, rb].filter((r) => !r.isError).length;
  assert.equal(winners, 1, `赢家数 ${winners}：A=${ra.text.slice(0, 60)} B=${rb.text.slice(0, 60)}`);
  assert.equal(t.nodes, 20);
  return `holder=${t.session.runLockHolder}`;
});

// ── 4. 批量上限 / 半途断开 ────────────────────────────────────────────────
await step('批量上限：add_nodes / update_nodes 超过 500 项整批拒绝，一个都不落库', async () => {
  const c = (await call(A, 'create_canvas', { title: 'stress cap' })).json.canvasId;
  const r = await call(A, 'add_nodes', { canvasId: c, nodes: nodeSpecs(501, 'cap') });
  const u = await call(A, 'update_nodes', {
    canvasId: big,
    updates: shortIds.slice(0, 501).map((id) => ({ nodeId: id, label: 'over-cap' })),
  });
  assert.ok(r.isError && /500|too_big|Too big/i.test(r.text), r.text.slice(0, 200));
  assert.ok(u.isError, u.text.slice(0, 200));
  assert.equal((await truth(c)).nodes, 0);
  assert.equal(await prisma.canvasNode.count({ where: { sessionId: big, label: 'over-cap' } }), 0);
  const ok = await call(A, 'add_nodes', { canvasId: c, nodes: nodeSpecs(500, 'cap') });
  assert.equal(ok.json?.created, 500, ok.text.slice(0, 200));
  return `501 项→${r.text.slice(0, 60)}；500 项→created=${ok.json.created}`;
});

await step('半途断开：add_nodes×500 发出后很快中止，服务端停在中止处、不再继续建', async () => {
  const c = (await call(A, 'create_canvas', { title: 'stress abort' })).json.canvasId;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const r = await call(A, 'add_nodes', { canvasId: c, nodes: nodeSpecs(500, 'ab') }, { signal: ac.signal });
  const t1 = await truth(c);
  await new Promise((res) => setTimeout(res, 5000));
  const t2 = await truth(c);
  assert.equal(t2.revision, t2.ops);
  // 中止信号从断开的 HTTP 连接一路传到批量循环需要几步，允许中止后再多建几个
  assert.ok(t2.nodes < 500, `中止后服务端仍把 500 个全部建完（${t2.nodes}）`);
  assert.ok(t2.nodes - t1.nodes <= 20, `中止后又建了 ${t2.nodes - t1.nodes} 个`);
  return `客户端：${r.text.slice(0, 50)}；中止时 ${t1.nodes}，5s 后 ${t2.nodes}`;
});

// ── 5. 异常入参 ──────────────────────────────────────────────────────────
await step('异常入参：越界坐标 / 超长 label / 自环 / 环 / 超 1MB 请求体都被拒，报错不带服务端细节', async () => {
  const c = (await call(A, 'create_canvas', { title: 'stress input' })).json.canvasId;
  const out = {};
  const texts = [];
  const rec = (k, r) => {
    texts.push(r.text);
    out[k] = r.text.slice(0, 70);
    return r;
  };
  rec('empty', await call(A, 'add_nodes', { canvasId: c, nodes: [] }));
  const mixed = rec('mixed', await call(A, 'add_nodes', {
    canvasId: c,
    nodes: [
      { type: 'image_upload', x: 0, y: 0 },
      { type: 'nope', x: 1, y: 1 },
      { type: 'image_gen', prompt: 'ok', x: 2, y: 2 },
      { type: 'image_upload', label: 'L'.repeat(500), x: 3, y: 3 },
    ],
  }));
  assert.equal(mixed.json?.created, 2, mixed.text.slice(0, 200));
  const before = await truth(c);
  const huge = rec('hugeXY', await call(A, 'add_node', { canvasId: c, type: 'image_upload', x: 1e308, y: 0 }));
  const longLabel = rec('label200k', await call(A, 'add_node', { canvasId: c, type: 'image_upload', label: 'L'.repeat(200_000), x: 0, y: 0 }));
  const tooBig = rec('body1_2MB', await call(A, 'add_node', { canvasId: c, type: 'image_upload', label: 'B'.repeat(1_200_000), x: 0, y: 0 }));
  assert.ok(huge.text.includes('70014'), huge.text);
  assert.ok(longLabel.text.includes('70014'), longLabel.text);
  assert.ok(/413|too large/i.test(tooBig.text), tooBig.text);
  assert.equal((await truth(c)).nodes, before.nodes, '被拒的请求不该落库');
  // 连线：自环 / 绕回来的环拒绝；重复连线幂等复用同一条
  const g = (await call(A, 'add_nodes', { canvasId: c, nodes: [0, 1, 2].map((i) => ({ type: 'image_gen', prompt: `c${i}`, x: i * 300, y: 400 })) })).json.results.map((r) => r.nodeId);
  const self = rec('selfLoop', await call(A, 'connect_nodes', { canvasId: c, sourceId: g[0], targetId: g[0] }));
  const ab = await call(A, 'connect_nodes', { canvasId: c, sourceId: g[0], targetId: g[1] });
  await call(A, 'connect_nodes', { canvasId: c, sourceId: g[1], targetId: g[2] });
  const cycle = rec('cycle', await call(A, 'connect_nodes', { canvasId: c, sourceId: g[2], targetId: g[0] }));
  const dup = await call(A, 'connect_nodes', { canvasId: c, sourceId: g[0], targetId: g[1] });
  assert.ok(self.text.includes('70015'), self.text);
  assert.ok(cycle.text.includes('70015'), cycle.text);
  assert.equal(dup.json?.edgeId, ab.json?.edgeId, '重复连线应复用原来那条');
  assert.equal((await truth(c)).edges, 2);
  rec('crossCanvas', await call(A, 'connect_nodes', { canvasId: c, sourceId: shortIds[500], targetId: shortIds[501] }));
  const wait60 = rec('wait60', await call(A, 'wait_for_generations', { canvasId: c, generationIds: ['g1'], timeoutSeconds: 60 }));
  assert.ok(!wait60.protocol, `timeoutSeconds=60 应被接受（按 25 秒封顶）：${wait60.text}`);
  const leak = texts.find((t) => /\/Users\/|\.ts:\d+|invocation in|prisma/i.test(t));
  assert.ok(!leak, `报错带出了服务端细节：${leak?.slice(0, 200)}`);
  return JSON.stringify(out);
});
async function firstNode(c) {
  return (await prisma.canvasNode.findFirst({ where: { sessionId: c } })).id;
}
function shortIdOf(id) {
  return id.slice(-6);
}

await step('长文件名上传：标题截到 191 字，上传成功、不留孤儿素材', async () => {
  // 用网页用户的身份建画布与节点、上传（MCP 写过的画布会被锁 60 秒，这里不经 MCP）
  const { sessionId: c } = await apiOk(jwt, '/canvas', { method: 'POST', body: JSON.stringify({ title: 'stress long filename' }) });
  const snap = await apiOk(jwt, `/canvas/${c}`);
  const added = await apiOk(jwt, `/canvas/${c}/ops`, {
    method: 'POST',
    body: JSON.stringify({ baseRevision: snap.revision, op: { op: 'add_node', type: 'image_upload', x: 0, y: 0 } }),
  });
  const nodeId = added.patch.node.id;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const name = `${'很长的文件名'.repeat(40)}.png`; // 241 字
  const res = await fetch(`${API}/canvas/${c}/nodes/${nodeId}/upload?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'image/png' },
    body: png,
  });
  const body = await res.json();
  assert.equal(body.code, 0, JSON.stringify(body));
  const node = await prisma.canvasNode.findUnique({ where: { id: nodeId } });
  assert.equal([...node.label].length, 191, `标题长度 ${[...node.label].length}`);
  assert.ok(node.mediaGenerationId, '节点应挂上上传的素材');
  return `标题 ${[...node.label].length} 字，素材已挂上`;
});

// ── 6. 模拟生成批量 ───────────────────────────────────────────────────────
await step('模拟生成：30 个 image_gen 并行触发，wait_for_generations 分批等齐', async () => {
  const c = (await call(A, 'create_canvas', { title: 'stress gen' })).json.canvasId;
  // 模拟生成是画布级开关（mockMedia），环境变量只决定这个开关能不能开；不开就会真提交 aigc 花额度
  await apiOk(jwt, `/canvas/${c}`, { method: 'PATCH', body: JSON.stringify({ mockMedia: true }) });
  const add = await call(A, 'add_nodes', {
    canvasId: c,
    nodes: Array.from({ length: 30 }, (_, i) => ({ type: 'image_gen', prompt: `mock ${i}`, x: i * 320, y: 0 })),
  });
  const ids = add.json.results.map((r) => r.nodeId);
  // 先触发一个确认确实走模拟，再并行触发其余的
  const first = await call(A, 'generate_media_node', { canvasId: c, nodeId: ids[0] });
  const v0 = await prisma.mediaVersion.findFirst({ where: { generationId: first.json?.generationId } });
  assert.equal(v0?.mock, true, `没走模拟生成，停止以免花额度：${first.text}`);
  const gens = [first, ...(await Promise.all(ids.slice(1).map((id) => call(A, 'generate_media_node', { canvasId: c, nodeId: id }))))];
  const genIds = gens.map((g) => g.json?.generationId).filter(Boolean);
  const errs = gens.filter((g) => !g.json?.generationId).map((g) => g.text.slice(0, 80));
  const t0 = Date.now();
  const states = [];
  const waitErrors = [];
  for (let i = 0; i < genIds.length; i += 20) {
    let w;
    do {
      w = await call(A, 'wait_for_generations', { canvasId: c, generationIds: genIds.slice(i, i + 20), timeoutSeconds: 25 });
      if (w.protocol) waitErrors.push(w.text.slice(0, 80));
    } while (!w.json?.done && Date.now() - t0 < 300_000);
    states.push(...(w.json?.generations ?? []));
  }
  const done = states.filter((s) => s.status === 'done').length;
  const mock = states.every((s) => s.mock);
  assert.ok(mock, '应全部走模拟生成');
  assert.equal(waitErrors.length, 0, `wait_for_generations 被反代掐断：${waitErrors.join(' | ')}`);
  if (errs.length) finding(`30 路并行 generate_media_node 有 ${errs.length} 路失败：${[...new Set(errs)].join(' | ')}`);
  return `触发 ${genIds.length}/30，done ${done}，耗时 ${Math.round((Date.now() - t0) / 1000)}s`;
});

// ── 7. 显式清空 + 全局对账 ────────────────────────────────────────────────
await step('显式 clear_canvas：大画布清空，revision 只 +1，对照画布毫发无损', async () => {
  const before = await truth(big);
  const t0 = Date.now();
  const r = await call(A, 'clear_canvas', { canvasId: big });
  assert.ok(!r.isError, r.text);
  const after = await truth(big);
  assert.equal(after.nodes, 0);
  assert.equal(after.edges, 0);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.clearOps, 1, '整个测试只该有这一次 clear');
  const ctl = await truth(control);
  const oth = await truth(otherControl);
  assert.equal(ctl.nodes, baseline.control.nodes);
  assert.equal(ctl.revision, baseline.control.revision);
  assert.equal(oth.nodes, baseline.other.nodes);
  assert.equal(oth.revision, baseline.other.revision);
  return `清掉 ${before.nodes} 节点 / ${before.edges} 连线，${Date.now() - t0}ms`;
});

// ── 收尾 ─────────────────────────────────────────────────────────────────
for (const c of [A, B, RO, OTHER]) await c.close().catch(() => {});
for (const { jwt: j, id } of patIds) {
  await api(j, `/mcp-server/grants/${id}`, { method: 'DELETE' });
}
await prisma.$disconnect();

console.log('\n计时：', JSON.stringify(timing));
console.log(`\n发现 ${findings.length} 项：`);
for (const f of findings) console.log(` - ${f}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
