#!/usr/bin/env node
/**
 * 画布 MCP 对外服务端到端测试：用 MCP 官方 SDK 的 Client 真连主站 /mcp（经前端 rewrites 到后端），
 * 覆盖 PAT 与 OAuth（发现 → DCR → 授权 → 同意 → 换码 → 刷新 → 吊销）两条授权路径与画布工具。
 *
 * 前置：前端 3100 + 后端 3101 已起；本地未配 RESEND_API_KEY（验证码随响应返回）；
 * 后端 CANVAS_MOCK_MEDIA_ENABLED=true —— 生成只走测试模式（本地占位素材），不调 aigc、不花钱。
 * 用专用测试账号，不碰真实用户数据。
 *
 * 运行：node test/canvas-mcp-server.e2e.mjs（apps/backend 目录下）
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SITE = process.env.E2E_SITE ?? 'http://localhost:3100';
const API = process.env.E2E_API ?? 'http://localhost:3101';
const MCP_URL = new URL('/mcp', SITE);
const EMAIL = 'e2e-canvas-mcp@example.test';
const OTHER_EMAIL = 'e2e-canvas-mcp-other@example.test';

const results = [];
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

/** 站内接口（JWT，{code,message,data} 信封） */
async function api(jwt, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
  });
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function login(email) {
  const { code } = await api(null, '/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  assert.ok(code, '本地应未配 RESEND，验证码随响应返回');
  const { token } = await api(null, '/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
  return token;
}

async function patClient(token) {
  // title 即画布上「xx is editing」显示的 agent 名（MCP initialize 里的 clientInfo）
  const client = new Client({ name: 'e2e-pat', title: 'E2E Agent', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** 工具结果 → 解析出的 JSON（文本内容） */
async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { isError: r.isError === true, json, text };
}

const ALL = ['canvas:read', 'canvas:write', 'media:generate'];
const created = []; // 结束时吊销的 PAT

const jwt = await login(EMAIL);
const otherJwt = await login(OTHER_EMAIL);

let pat = '';
let canvasId = '';
let client;

await step('PAT：创建后连上 /mcp，工具列表齐全', async () => {
  const r = await api(jwt, '/mcp-server/grants', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e PAT', scopes: ALL, expiresInDays: 30 }),
  });
  assert.match(r.token, /^cvs_pat_/);
  created.push(r.grant.id);
  pat = r.token;
  client = await patClient(pat);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of [
    'list_canvases',
    'create_canvas',
    'get_canvas',
    'wait_for_generations',
    'import_asset',
    'add_nodes',
    'connect_nodes',
    'generate_media_node',
    'clear_canvas',
  ]) {
    assert.ok(names.includes(n), `缺工具 ${n}`);
  }
  return `${names.length} 个工具`;
});

let nodeA = '';
let nodeB = '';
await step(
  'create_canvas → add_nodes → connect_nodes → get_canvas',
  async () => {
    const c = await call(client, 'create_canvas', { title: 'MCP e2e' });
    assert.equal(c.isError, false, c.text);
    canvasId = c.json.canvasId;
  // 第三方 agent 拿它在预览里打开画布，让用户实时看到改动
  assert.equal(c.json.canvasUrl, `${SITE}/canvas/${canvasId}`);
    const add = await call(client, 'add_nodes', {
      canvasId,
      nodes: [
        { type: 'image_gen', prompt: '一只橘猫，水彩', x: 40, y: 40 },
        { type: 'image_gen', prompt: '同一只猫戴帽子', x: 360, y: 40 },
      ],
    });
    assert.equal(add.json.created, 2, add.text);
    [nodeA, nodeB] = add.json.results.map((r) => r.nodeId);
    const link = await call(client, 'connect_nodes', {
      canvasId,
      sourceId: nodeA,
      targetId: nodeB,
    });
    assert.equal(link.isError, false, link.text);
    const g = await call(client, 'get_canvas', { canvasId });
    assert.equal(g.json.canvasUrl, `${SITE}/canvas/${canvasId}`);
  assert.match(g.json.state, new RegExp(`${nodeA} \\[image_gen\\]`));
    assert.match(g.json.state, new RegExp(`${nodeA} → ${nodeB}`));
    assert.match(g.json.runLock?.holderId ?? '', /^mcp:/);
    // label = 客户端在 initialize 里自报的 title，而不是 PAT 名
    assert.equal(g.json.runLock?.label, 'E2E Agent');
    return `canvas=${canvasId}`;
  },
);

await step('网页端看到的快照：节点、连线与锁 label（同一份数据）', async () => {
  const snap = await api(jwt, `/canvas/${canvasId}`);
  assert.equal(snap.nodes.length, 2);
  assert.equal(snap.edges.length, 1);
  assert.match(snap.runLock.holderId, /^mcp:/);
  assert.equal(snap.runLock.label, 'E2E Agent');
});

await step(
  '模拟生成：generate_media_node → wait_for_generations 拿到可下载的产物 URL',
  async () => {
    await api(jwt, `/canvas/${canvasId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mockMedia: true }),
    });
    const gen = await call(client, 'generate_media_node', {
      canvasId,
      nodeId: nodeA,
    });
    assert.equal(gen.isError, false, gen.text);
    assert.equal(gen.json.status, 'queued', gen.text);
    // 上游还在排队也能直接触发下游
    const gen2 = await call(client, 'generate_media_node', {
      canvasId,
      nodeId: nodeB,
    });
    assert.ok(gen2.json.generationId, gen2.text);
    let w;
    for (let i = 0; i < 5; i++) {
      w = await call(client, 'wait_for_generations', {
        canvasId,
        generationIds: [gen.json.generationId, gen2.json.generationId],
        timeoutSeconds: 60,
      });
      if (w.json.done) break;
    }
    assert.equal(w.json.done, true, w.text);
    for (const g of w.json.generations) {
      assert.equal(g.status, 'done', w.text);
      assert.equal(g.mock, true);
      const res = await fetch(g.url);
      assert.equal(res.status, 200, `产物 URL 打不开：${g.url}`);
      assert.match(res.headers.get('content-type') ?? '', /^image\//);
    }
    return w.json.generations.map((g) => g.url.split('?')[0]).join(', ');
  },
);

await step(
  'wait_for_generations：不属于这块画布的任务回 not_found',
  async () => {
    const w = await call(client, 'wait_for_generations', {
      canvasId,
      generationIds: ['nonexistent-generation'],
      timeoutSeconds: 1,
    });
    assert.equal(w.json.generations[0].status, 'not_found');
  },
);

await step(
  'import_asset：SSRF 防护（http / 回环 / 内网 / 云元数据）',
  async () => {
    for (const url of [
      'http://example.com/a.png',
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.png',
    ]) {
      const r = await call(client, 'import_asset', { canvasId, url });
      assert.equal(r.isError, true, `${url} 应被拒：${r.text}`);
    }
  },
);

await step('租户隔离：别人的 PAT 读不到、改不了这块画布', async () => {
  const r = await api(otherJwt, '/mcp-server/grants', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e other', scopes: ALL }),
  });
  created.push(r.grant.id);
  const other = await patClient(r.token);
  const read = await call(other, 'get_canvas', { canvasId });
  assert.equal(read.isError, true, read.text);
  const write = await call(other, 'add_node', {
    canvasId,
    type: 'image_gen',
    x: 0,
    y: 0,
  });
  assert.equal(write.isError, true, write.text);
  await other.close();
});

await step('只读 PAT：写工具不出现在列表里，调用也被拒', async () => {
  const r = await api(jwt, '/mcp-server/grants', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e readonly', scopes: ['canvas:read'] }),
  });
  created.push(r.grant.id);
  const ro = await patClient(r.token);
  const names = (await ro.listTools()).tools.map((t) => t.name);
  assert.ok(
    !names.includes('add_node') && !names.includes('generate_media_node'),
  );
  const res = await ro.callTool({
    name: 'add_node',
    arguments: { canvasId, type: 'image_gen', x: 0, y: 0 },
  });
  assert.equal(res.isError, true);
  await ro.close();
  return names.join(',');
});

// ───────────────────────────── OAuth ─────────────────────────────

/** 内存版 OAuthClientProvider：redirectToAuthorization 记下授权地址，交给「浏览器」那一步 */
function memoryProvider() {
  const store = { authUrl: null };
  const p = {
    store,
    get redirectUrl() {
      return 'http://127.0.0.1:53682/callback';
    },
    get clientMetadata() {
      return {
        client_name: 'e2e OAuth client',
        redirect_uris: ['http://127.0.0.1:53682/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => store.client,
    saveClientInformation: (c) => (store.client = c),
    tokens: () => store.tokens,
    saveTokens: (t) => (store.tokens = t),
    redirectToAuthorization: (u) => (store.authUrl = u),
    saveCodeVerifier: (v) => (store.verifier = v),
    codeVerifier: () => store.verifier,
    state: () => 'e2e-state',
  };
  return p;
}

const oauth = memoryProvider();
let oauthGrantId = '';

await step(
  'OAuth：401 → 发现 → DCR → 授权跳同意页 → 允许 → 换码 → 调工具',
  async () => {
    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      authProvider: oauth,
    });
    const c1 = new Client({ name: 'e2e-oauth', version: '0' });
    await assert.rejects(c1.connect(transport), UnauthorizedError);
    assert.ok(oauth.store.client?.client_id, '应已动态注册客户端');
    const authUrl = oauth.store.authUrl;
    assert.equal(authUrl.origin + authUrl.pathname, `${SITE}/oauth/authorize`);

    // 「浏览器」打开授权地址 → 被送到前端同意页
    const r = await fetch(authUrl, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const consent = new URL(r.headers.get('location'));
    assert.equal(consent.pathname, '/oauth/consent');
    const requestId = consent.searchParams.get('request');
    const details = await api(jwt, `/mcp-server/consent/${requestId}`);
    assert.equal(details.clientName, 'e2e OAuth client');
    assert.equal(details.redirectHost, '127.0.0.1:53682');

    // 用户点「允许」→ 回跳客户端
    const { redirectUrl } = await api(
      jwt,
      `/mcp-server/consent/${requestId}/approve`,
      { method: 'POST' },
    );
    const back = new URL(redirectUrl);
    assert.equal(back.searchParams.get('state'), 'e2e-state');
    await transport.finishAuth(back.searchParams.get('code'));
    assert.match(oauth.store.tokens.access_token, /^cvs_at_/);

    const c2 = new Client({ name: 'e2e-oauth', version: '0' });
    await c2.connect(
      new StreamableHTTPClientTransport(MCP_URL, { authProvider: oauth }),
    );
    const g = await call(c2, 'get_canvas', { canvasId });
    assert.equal(g.isError, false, g.text);
    await c2.close();

    const grants = await api(jwt, '/mcp-server/grants');
    const og = grants.find(
      (x) => x.kind === 'oauth' && x.name === 'e2e OAuth client',
    );
    assert.ok(og, '「已授权应用」里应出现这条 OAuth 授权');
    assert.ok(og.lastUsedAt, '应记录最后使用时间');
    oauthGrantId = og.id;
  },
);

await step('OAuth：refresh 轮换，旧 refresh 再用被拒', async () => {
  const old = oauth.store.tokens;
  const refresh = (rt) =>
    fetch(`${SITE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
        client_id: oauth.store.client.client_id,
      }),
    });
  const r1 = await refresh(old.refresh_token);
  assert.equal(r1.status, 200, await r1.clone().text());
  const fresh = await r1.json();
  assert.notEqual(fresh.access_token, old.access_token);
  const r2 = await refresh(old.refresh_token);
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, 'invalid_grant');
  oauth.store.tokens = fresh;
});

await step('OAuth：在「已授权应用」吊销后，令牌立即 401', async () => {
  await api(jwt, `/mcp-server/grants/${oauthGrantId}`, { method: 'DELETE' });
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${oauth.store.tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata=/);
});

await step('同意页拒绝 → 回跳带 error=access_denied', async () => {
  const p = memoryProvider();
  const t = new StreamableHTTPClientTransport(MCP_URL, { authProvider: p });
  await assert.rejects(
    new Client({ name: 'x', version: '0' }).connect(t),
    UnauthorizedError,
  );
  const r = await fetch(p.store.authUrl, { redirect: 'manual' });
  const requestId = new URL(r.headers.get('location')).searchParams.get(
    'request',
  );
  const { redirectUrl } = await api(
    jwt,
    `/mcp-server/consent/${requestId}/deny`,
    { method: 'POST' },
  );
  assert.equal(new URL(redirectUrl).searchParams.get('error'), 'access_denied');
});

await client?.close();
for (const id of created) {
  await api(id === created[1] ? otherJwt : jwt, `/mcp-server/grants/${id}`, {
    method: 'DELETE',
  }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
