import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { readRawFile, type PortUpstream } from '../agent/sandbox';
import { parseRange, RawFileCache } from '../sandbox/raw-file';
import { parsePreviewHost } from './preview-host';
import {
  type PreviewSession,
  PreviewSessionService,
} from './preview-session.service';
import {
  downstreamResponseHeaders,
  upgradeRequestHeaders,
  upstreamRequestHeaders,
} from './proxy-headers';
import { fileResponseHeaders, resolveSitePath } from './site-files';

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
/** 上游 HTTP 连接空闲超时：dev server 卡住时不让连接一直挂着（SSE 等流式响应只要还在出数据就不算空闲）。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;
/** WebSocket 握手超时：握手完成后长连接不设超时。 */
const UPGRADE_TIMEOUT_MS = 15_000;

/** 上游连不上（而不是上游返回了错误）的错误码：这类情况值得重新解析上游地址再试一次。 */
const RETRYABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 预览子域名：`p-<id>.<基域名>` 上的请求按会话类型处理——
 * - 端口会话：原样转发到用户沙箱端口（运行中的 dev server / web 服务，含 WebSocket）；
 * - 文件会话：直接读用户工作区里的静态文件（静态网页预览）。
 * 两者都让预览页拥有独立于主站的源，所以页面能正常用 localStorage 等存储，又拿不到主站登录态。
 *
 * 在 main.ts 里挂在**所有** Nest 中间件之前（不经 CORS / 日志 / 鉴权 / 响应包装）：
 * 预览站点是另一个源，与主站 API 无关；访问凭证就是子域名里的会话 id。
 * 提供方要求的访问令牌由这里注入请求头，从不下发给浏览器（E2B 关闭公网访问时
 * 令牌只能放请求头，iframe 带不上——这正是走反代而不是直连提供方地址的原因）。
 *
 * 出站一律用 http(s).request：开了 NODE_USE_ENV_PROXY 时它走 HTTPS_PROXY（2026-10-17 实测），
 * 需要代理出网的部署环境里 HTTP 与 WebSocket 都能通。
 */
@Injectable()
export class PreviewProxy {
  private readonly logger = new Logger(PreviewProxy.name);
  /** 静态文件短时缓存：只给 Range 续传用（视频拖动进度条会对同一文件发多次 Range）。 */
  private readonly fileCache = new RawFileCache();

  constructor(private readonly sessions: PreviewSessionService) {}

  /** express 中间件：不是预览主机就 next()，交还正常路由。 */
  readonly http = (
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
    next: () => void,
  ): void => {
    const id = parsePreviewHost(req.headers.host);
    if (!id) return next();
    void this.forward(id, req, res);
  };

  private async forward(
    id: string,
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
  ): Promise<void> {
    let session: PreviewSession | null;
    try {
      session = await this.sessions.get(id);
    } catch (e) {
      this.logger.warn(`预览会话读取失败 id=${id}: ${String(e)}`);
      res.writeHead(502, TEXT);
      res.end('预览暂时不可用，请稍后重试。');
      return;
    }
    if (!session) {
      res.writeHead(404, TEXT);
      res.end('预览已过期或已重置。请回到对话里重新打开预览。');
      return;
    }
    // 有人在用预览：让沙箱保持活跃（内部节流，不阻塞请求）
    void this.sessions.keepAlive(session.u);
    if (session.kind === 'file') return this.serveFile(session, req, res);
    return this.forwardToPort(id, req, res);
  }

  /**
   * 端口会话：请求/响应按字节流原样透传（不解压不改写正文），只改写头。
   * 上游连不上时，GET/HEAD（没有请求体，可以安全重放）重新解析上游地址再试一次——
   * 沙箱可能停机重建过，缓存里的旧地址已失效；其余方法不重放，只让下一个请求重新解析。
   */
  private async forwardToPort(
    id: string,
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
  ): Promise<void> {
    const path = req.originalUrl ?? req.url ?? '/';
    const replayable = req.method === 'GET' || req.method === 'HEAD';
    const fail = (status: number, e: unknown) => {
      this.logger.warn(`预览转发失败 id=${id} ${path}: ${String(e)}`);
      if (!res.headersSent) res.writeHead(status, TEXT);
      res.end(
        status === 504
          ? '预览服务响应超时。'
          : '预览服务连接失败：确认沙箱里的服务正在运行并监听 0.0.0.0。',
      );
    };

    const attempt = async (fresh: boolean): Promise<void> => {
      let upstream: PortUpstream | null;
      try {
        upstream = await this.sessions.upstream(id, fresh);
      } catch (e) {
        return fail(502, e);
      }
      if (!upstream) {
        res.writeHead(404, TEXT);
        res.end('沙箱未在运行。请回到对话里让 agent 重新启动服务后再预览。');
        return;
      }
      const target = new URL(upstream.origin);
      const origin = upstream.origin;
      const upReq = (target.protocol === 'https:' ? https : http).request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: req.method,
          path,
          headers: {
            ...upstreamRequestHeaders(req.headers, upstream.headers),
            host: target.host,
          },
        },
        (upRes) => {
          res.writeHead(
            upRes.statusCode ?? 502,
            downstreamResponseHeaders(upRes.headers, origin),
          );
          upRes.pipe(res);
        },
      );
      upReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        upReq.destroy(
          Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }),
        );
      });
      upReq.on('error', (e: NodeJS.ErrnoException) => {
        const retryable = !res.headersSent && RETRYABLE.has(e.code ?? '');
        if (retryable && replayable && !fresh) {
          void attempt(true);
          return;
        }
        if (retryable) void this.sessions.upstream(id, true).catch(() => null);
        fail(e.code === 'ETIMEDOUT' ? 504 : 502, e);
      });
      if (replayable) upReq.end();
      else req.pipe(upReq);
    };

    await attempt(false);
  }

  /**
   * 文件会话：按请求路径读站点根下的工作区文件。只读，只接受 GET/HEAD。
   * 读失败先换一个新的沙箱句柄重试一次（缓存的句柄可能因沙箱停机/重建失效），仍失败按 404。
   * 支持单段 Range（视频拖动进度条）：续传请求优先用短时缓存，从头请求总是回源（拿到最新内容）。
   */
  private async serveFile(
    session: Extract<PreviewSession, { kind: 'file' }>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...TEXT, allow: 'GET, HEAD' });
      res.end('静态网页预览只读');
      return;
    }
    const rel = resolveSitePath(session.root, req.url ?? '/');
    if (!rel) {
      res.writeHead(404, TEXT);
      res.end('文件不存在');
      return;
    }
    const rangeHeader = req.headers.range;
    const cacheKey = `${session.u}:${rel}`;
    const isContinuation = /^bytes=[1-9]/.test(rangeHeader?.trim() ?? '');
    let data = isContinuation ? this.fileCache.get(cacheKey) : undefined;
    if (!data) {
      const read = async (fresh: boolean) => {
        const sb = await this.sessions.sandboxFor(session.u, fresh);
        return sb ? readRawFile(sb, rel) : undefined;
      };
      try {
        data = await read(false);
      } catch {
        data = await read(true).catch(() => undefined);
      }
      if (data) this.fileCache.set(cacheKey, data);
    }
    if (!data) {
      res.writeHead(404, TEXT);
      res.end(`文件不存在：${rel}`);
      return;
    }

    const headers = { ...fileResponseHeaders(rel), 'accept-ranges': 'bytes' };
    const range = parseRange(rangeHeader, data.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        ...headers,
        'content-range': `bytes */${data.length}`,
      });
      res.end();
      return;
    }
    const body = range ? data.subarray(range.start, range.end + 1) : data;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'content-length': String(body.length),
      ...(range
        ? {
            'content-range': `bytes ${range.start}-${range.end}/${data.length}`,
          }
        : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * HTTP upgrade（WebSocket，如 vite HMR）。返回 false = 不是预览主机，调用方交给其它监听者
   * （socket.io）。是预览主机时用 http(s).request 向上游发同样的升级请求（因此同样走代理），
   * 拿到 101 后把握手响应回给浏览器、双向透传字节——不解析 WebSocket 帧，任何子协议都原样通过。
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const id = parsePreviewHost(req.headers.host);
    if (!id) return false;
    void this.tunnel(id, req, socket, head);
    return true;
  }

  private async tunnel(
    id: string,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on('error', () => socket.destroy());
    const session = await this.sessions.get(id).catch(() => null);
    const upstream =
      session?.kind === 'port'
        ? await this.sessions.upstream(id).catch(() => null)
        : null;
    if (!session || !upstream) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    void this.sessions.keepAlive(session.u);
    const target = new URL(upstream.origin);
    const headers = Object.fromEntries(
      upgradeRequestHeaders(req.headers, target.host, upstream.headers),
    );
    const upReq = (target.protocol === 'https:' ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers,
    });
    upReq.setTimeout(UPGRADE_TIMEOUT_MS, () => {
      upReq.destroy(new Error('websocket handshake timeout'));
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      upReq.setTimeout(0);
      socket.write(statusBlock(upRes));
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      upSocket.on('close', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
    });
    // 上游拒绝升级（404 / 403 等）：把它的响应原样回给浏览器后关闭
    upReq.on('response', (upRes) => {
      socket.write(statusBlock(upRes));
      upRes.pipe(socket);
    });
    upReq.on('error', (e) => {
      this.logger.warn(`预览 websocket 失败 id=${id}: ${String(e)}`);
      socket.destroy();
    });
    upReq.end();
  }
}

/** 把上游响应的状态行 + 原始头拼回 HTTP/1.1 文本（WebSocket 握手需要原样转给浏览器）。 */
function statusBlock(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}
