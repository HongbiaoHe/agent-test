import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreviewPageTool } from './preview-page.tool';

let ws: string;
let outside: string;
const servers: Server[] = [];

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-preview-ws-'));
  outside = await mkdtemp(join(tmpdir(), 'spark-preview-out-'));
  await mkdir(join(ws, 'app'));
  await writeFile(join(ws, 'app', 'index.html'), '<h1>hi</h1>');
  await writeFile(join(outside, 'evil.html'), '<h1>x</h1>');
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function listen(server: Server, host: string): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** 拿一个当前没人监听的端口：先占一个随机端口再立刻关掉 */
async function freePort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  await new Promise((r) => s.close(r));
  return port;
}

async function run(args: Record<string, unknown>, portWaitMs = 0): Promise<Record<string, unknown>> {
  const t = createPreviewPageTool({ workspaceDir: ws, portWaitMs });
  const out: unknown = await t.invoke(args);
  const parsed: unknown = JSON.parse(String(out));
  if (!parsed || typeof parsed !== 'object') throw new Error('非对象结果');
  return { ...parsed };
}

describe('preview_page（静态页）', () => {
  it('相对路径：返回工作区相对路径与文件名标题', async () => {
    expect(await run({ path: 'app/index.html' })).toEqual({
      path: 'app/index.html',
      title: 'index.html',
      status: 'opened',
    });
  });

  it('工作区内的绝对路径换成相对路径，title 可自定义', async () => {
    expect(await run({ path: join(ws, 'app', 'index.html'), title: '待办' })).toEqual({
      path: 'app/index.html',
      title: '待办',
      status: 'opened',
    });
  });

  it('文件不存在 → 报错并提示先写文件', async () => {
    const r = await run({ path: 'app/missing.html' });
    expect(r.error).toContain('文件不存在');
    expect(r.hint).toContain('write_file');
  });

  it('工作区外（绝对路径 / ../ / 软链出域）→ 拒绝', async () => {
    expect((await run({ path: join(outside, 'evil.html') })).error).toContain('不在工作区内');
    await symlink(join(outside, 'evil.html'), join(ws, 'link.html'));
    expect((await run({ path: 'link.html' })).error).toContain('不在工作区内');
  });

  it('不是 .html → 拒绝', async () => {
    expect((await run({ path: 'app/readme.md' })).error).toContain('.html');
  });
});

describe('preview_page（端口）', () => {
  it('127.0.0.1 上在监听 → opened，path 缺省 /', async () => {
    const port = await listen(createServer(), '127.0.0.1');
    expect(await run({ port })).toEqual({ port, path: '/', title: `localhost:${port}`, status: 'opened' });
  });

  it('只监听 ::1 也算可达（vite 默认 localhost 可能落在 IPv6）', async () => {
    const port = await listen(createServer(), '::1');
    expect((await run({ port, path: '/dashboard' })).status).toBe('opened');
  });

  it('没在监听 → 报错并提示用 run_in_background 启动', async () => {
    const r = await run({ port: await freePort() });
    expect(r.error).toContain('没有服务在监听');
    expect(r.hint).toContain('run_in_background');
  });

  it('服务稍后才就绪：等待期内起来就算成功', async () => {
    const port = await freePort();
    const server = createServer();
    servers.push(server);
    setTimeout(() => server.listen(port, '127.0.0.1'), 300);
    expect((await run({ port }, 5_000)).status).toBe('opened');
  });

  it('端口越界 / path 不以 / 开头 → 拒绝', async () => {
    expect((await run({ port: 70000 })).error).toContain('1-65535');
    expect((await run({ port: 3000, path: 'x' })).error).toContain('必须以 /');
  });
});
