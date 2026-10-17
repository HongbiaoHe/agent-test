jest.mock('../agent/sandbox-providers', () => ({}));
/** 模拟沙箱工作区：文件会话的读取走 readRawFile(sandbox, 工作区相对路径) */
const WORKSPACE: Record<string, string> = {
  'site/index.html': '<h1>home</h1>',
  'site/app.js': 'console.log(1)',
  'site/sub/index.html': '<h1>sub</h1>',
  'site/中文 名.css': 'b{}',
  'secret.txt': 'TOP SECRET',
};
const mockReadRawFile = jest.fn((_sb: unknown, rel: string) =>
  rel in WORKSPACE
    ? Promise.resolve(new TextEncoder().encode(WORKSPACE[rel]))
    : Promise.reject(new Error('file_not_found')),
);
jest.mock('../agent/sandbox', () => ({
  readRawFile: (sb: unknown, rel: string) => mockReadRawFile(sb, rel),
}));
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { PreviewProxy } from './preview-proxy';
import type { PreviewSessionService } from './preview-session.service';

/**
 * 反代集成测试：本机起一个「上游」HTTP 服务充当沙箱端口，再起一个挂了 PreviewProxy 的服务，
 * 用预览主机名发真实请求，检查令牌注入、流式透传、重定向改写与 WebSocket 升级透传。
 */
describe('PreviewProxy', () => {
  const ID = 'b'.repeat(32);
  const FILE_ID = 'f'.repeat(32);
  const DEAD_ID = 'd'.repeat(32);
  let sessions: {
    get: jest.Mock;
    sandboxFor: jest.Mock;
    upstream: jest.Mock;
    keepAlive: jest.Mock;
  };
  /** 一个已关闭端口：模拟「缓存里的上游地址已失效」 */
  let deadOrigin: string;
  let upstreamServer: http.Server;
  let proxyServer: http.Server;
  let proxyPort: number;
  let seen: { headers: http.IncomingHttpHeaders; body: string; url?: string }[];
  let upstreamOrigin: string | null;
  /** 升级后的 socket 脱离了 http 连接管理，closeAllConnections 管不到，收尾手动断 */
  const upgraded: Duplex[] = [];

  beforeAll(async () => {
    process.env.PREVIEW_PROXY_BASE = 'http://localhost:3101';
    upstreamServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ headers: req.headers, body, url: req.url });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: `${upstreamOrigin}/target` });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/plain', 'x-up': '1' });
        res.end(`echo:${req.method}:${req.url}:${body}`);
      });
    });
    // 上游的 WebSocket：完成 101 握手后把收到的字节原样回显
    upstreamServer.on('upgrade', (req, socket) => {
      upgraded.push(socket);
      seen.push({ headers: req.headers, body: '', url: req.url });
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.on('data', (d: Buffer) => socket.write(d));
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamOrigin = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;

    // 拿一个随即关闭的端口：连它会 ECONNREFUSED
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    deadOrigin = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`;
    await new Promise((r) => tmp.close(r));
    const upstreamFor = (id: string) =>
      Promise.resolve(
        id === ID
          ? {
              origin: upstreamOrigin!,
              headers: { 'x-preview-token': 'SECRET' },
            }
          : null,
      );

    sessions = {
      get: jest.fn((id: string) =>
        Promise.resolve(
          id === ID || id === DEAD_ID
            ? { u: 'u1', kind: 'port', port: 5173 }
            : id === FILE_ID
              ? { u: 'u1', kind: 'file', root: 'site' }
              : null,
        ),
      ),
      sandboxFor: jest.fn(() => Promise.resolve({ sb: 'cached' })),
      keepAlive: jest.fn(() => Promise.resolve()),
      // DEAD_ID：首次给缓存里的失效地址，fresh 重新解析才给到能用的上游
      upstream: jest.fn((id: string, fresh?: boolean) =>
        id === DEAD_ID
          ? Promise.resolve({
              origin: fresh ? upstreamOrigin! : deadOrigin,
              headers: { 'x-preview-token': 'SECRET' },
            })
          : upstreamFor(id),
      ),
    };
    const proxy = new PreviewProxy(
      sessions as unknown as PreviewSessionService,
    );
    proxyServer = http.createServer((req, res) =>
      proxy.http(req, res, () => {
        res.writeHead(418);
        res.end('main-app');
      }),
    );
    proxyServer.on('upgrade', (req, socket, head) => {
      upgraded.push(socket);
      if (!proxy.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    delete process.env.PREVIEW_PROXY_BASE;
    // keep-alive 连接（Node 22 全局 agent 默认开启）不会自己断，close 会一直等
    proxyServer.closeAllConnections();
    upstreamServer.closeAllConnections();
    for (const s of upgraded) s.destroy();
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => upstreamServer.close(r));
  });

  beforeEach(() => {
    seen = [];
  });

  function request(host: string, method: string, path: string, body?: string) {
    return new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method,
          path,
          headers: { host, 'x-preview-token': 'forged' },
        },
        (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: b,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  const previewHost = `p-${ID}.localhost:3101`;

  it('预览主机：转发到上游，注入服务端令牌（浏览器伪造的被替换），正文与请求体透传', async () => {
    const r = await request(previewHost, 'POST', '/api/x?y=1', 'hello');
    expect(r.status).toBe(200);
    expect(r.body).toBe('echo:POST:/api/x?y=1:hello');
    expect(r.headers['x-up']).toBe('1');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(seen[0].headers['x-preview-token']).toBe('SECRET');
  });

  it('上游重定向回自己 → 改成相对路径', async () => {
    const r = await request(previewHost, 'GET', '/redirect');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/target');
  });

  it('非预览主机 → 交还正常路由（next）', async () => {
    const r = await request('localhost:3101', 'GET', '/');
    expect(r.status).toBe(418);
    expect(r.body).toBe('main-app');
    expect(seen).toHaveLength(0);
  });

  it('会话不存在 → 404 提示，不连上游', async () => {
    const r = await request(`p-${'c'.repeat(32)}.localhost:3101`, 'GET', '/');
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('WebSocket 升级：带令牌重放握手，101 后双向透传字节', async () => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(
      `GET /hmr?token=t HTTP/1.1\r\nHost: ${previewHost}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    const handshake = await new Promise<string>((r) =>
      sock.once('data', (d: Buffer) => r(d.toString())),
    );
    expect(handshake).toContain('101 Switching Protocols');
    expect(seen[0].url).toBe('/hmr?token=t');
    expect(seen[0].headers['x-preview-token']).toBe('SECRET');
    sock.write('ping-bytes');
    const echoed = await new Promise<string>((r) =>
      sock.once('data', (d: Buffer) => r(d.toString())),
    );
    expect(echoed).toBe('ping-bytes');
    sock.destroy();
  });

  describe('文件会话（静态网页预览）', () => {
    const fileHost = `p-${FILE_ID}.localhost:3101`;

    beforeEach(() => {
      mockReadRawFile.mockClear();
      sessions.sandboxFor.mockClear();
    });

    it('按路径读站点根下的文件：类型正确、补 utf-8、no-referrer；没有 CSP sandbox（存储可用）', async () => {
      const r = await request(fileHost, 'GET', '/index.html');
      expect(r.status).toBe(200);
      expect(r.body).toBe('<h1>home</h1>');
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toBeUndefined();
      expect(mockReadRawFile).toHaveBeenCalledWith(
        { sb: 'cached' },
        'site/index.html',
      );
      const js = await request(fileHost, 'GET', '/app.js?v=1');
      expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    });

    it('目录路径补 index.html；文件名 URL 解码', async () => {
      expect((await request(fileHost, 'GET', '/')).body).toBe('<h1>home</h1>');
      expect((await request(fileHost, 'GET', '/sub/')).body).toBe(
        '<h1>sub</h1>',
      );
      const css = await request(
        fileHost,
        'GET',
        `/${encodeURIComponent('中文 名.css')}`,
      );
      expect(css.status).toBe(200);
    });

    it('越出站点根（..、编码的 ..）→ 404，读不到工作区其它文件', async () => {
      for (const p of ['/../secret.txt', '/%2e%2e/secret.txt']) {
        const r = await request(fileHost, 'GET', p);
        expect(r.status).toBe(404);
        expect(r.body).not.toContain('TOP SECRET');
      }
      expect(mockReadRawFile).not.toHaveBeenCalledWith(
        expect.anything(),
        'secret.txt',
      );
    });

    it('文件不存在 → 换新沙箱句柄重试一次后仍失败才 404', async () => {
      const r = await request(fileHost, 'GET', '/nope.html');
      expect(r.status).toBe(404);
      expect(sessions.sandboxFor).toHaveBeenNthCalledWith(1, 'u1', false);
      expect(sessions.sandboxFor).toHaveBeenNthCalledWith(2, 'u1', true);
    });

    it('只读：POST → 405；HEAD → 只回头不回正文', async () => {
      expect((await request(fileHost, 'POST', '/index.html', 'x')).status).toBe(
        405,
      );
      const head = await request(fileHost, 'HEAD', '/index.html');
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe(
        String('<h1>home</h1>'.length),
      );
    });

    it('文件会话不走端口转发（upstream 不被调用）', async () => {
      sessions.upstream.mockClear();
      await request(fileHost, 'GET', '/index.html');
      expect(sessions.upstream).not.toHaveBeenCalled();
    });
  });

  describe('可靠性：续期、重试、Range', () => {
    it('每个预览请求都触发续期（节流在会话服务里做）', async () => {
      sessions.keepAlive.mockClear();
      await request(previewHost, 'GET', '/x');
      await request(`p-${FILE_ID}.localhost:3101`, 'GET', '/index.html');
      expect(sessions.keepAlive).toHaveBeenCalledTimes(2);
      expect(sessions.keepAlive).toHaveBeenCalledWith('u1');
    });

    it('上游地址失效（连接被拒）→ GET 重新解析上游并重试一次，用户无感', async () => {
      const r = await request(
        `p-${DEAD_ID}.localhost:3101`,
        'GET',
        '/after-rebuild',
      );
      expect(r.status).toBe(200);
      expect(r.body).toBe('echo:GET:/after-rebuild:');
      expect(sessions.upstream).toHaveBeenCalledWith(DEAD_ID, true);
    });

    it('有请求体的方法不重放：失败返回 502，并让下一个请求重新解析', async () => {
      sessions.upstream.mockClear();
      const r = await request(
        `p-${DEAD_ID}.localhost:3101`,
        'POST',
        '/x',
        'body',
      );
      expect(r.status).toBe(502);
      expect(seen.some((s) => s.url === '/x' && s.body === 'body')).toBe(false);
      expect(sessions.upstream).toHaveBeenCalledWith(DEAD_ID, true);
    });

    it('静态文件支持 Range：206 + Content-Range；越界 416', async () => {
      const fileHost = `p-${FILE_ID}.localhost:3101`;
      const part = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            path: '/index.html',
            headers: { host: fileHost, range: 'bytes=1-3' },
          },
          (res) => {
            let b = '';
            res.on('data', (c: Buffer) => (b += c.toString()));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: b,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(part.status).toBe(206);
      expect(part.body).toBe('h1>');
      expect(part.headers['content-range']).toBe('bytes 1-3/13');
      expect(part.headers['accept-ranges']).toBe('bytes');
      const bad = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            path: '/index.html',
            headers: { host: fileHost, range: 'bytes=999-' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(bad).toBe(416);
    });

    it('文件会话不接受 WebSocket 升级（404）', async () => {
      const sock = net.connect(proxyPort, '127.0.0.1');
      await new Promise((r) => sock.once('connect', r));
      sock.write(
        `GET / HTTP/1.1\r\nHost: p-${FILE_ID}.localhost:3101\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      const resp = await new Promise<string>((r) =>
        sock.once('data', (d: Buffer) => r(d.toString())),
      );
      expect(resp).toContain('404');
      sock.destroy();
    });
  });
});
