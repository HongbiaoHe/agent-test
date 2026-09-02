import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

/** 探测结果缓存时长：隧道地址不常变，但重开隧道后要能自己跟上。 */
const CACHE_TTL_MS = 30_000;
/** ngrok 本机 API（隧道进程自带，见 scripts/tunnel.mjs）。 */
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
/** 前端 dev server 端口；经它反代到后端的同源前缀（见 apps/frontend/next.config.ts 的 rewrites）。 */
const FRONTEND_PORT = '3100';
const BACKEND_PREFIX_VIA_FRONTEND = '/api-backend';

/**
 * 「我方的公网基址」解析：aigc 要能回调我们、也要能下载我们给的参考图，
 * 两者都需要一个公网可达的 http(s) 地址。
 *
 * 取值顺序：
 *  1. `PUBLIC_BASE_URL`（部署环境显式配置，形如 https://api.example.com）；
 *  2. 本机 ngrok 的隧道地址（开发期 `pnpm tunnel` 起的那条）——随机域名每次都变，
 *     让后端自己问 ngrok 比让人来回抄进 .env 靠得住。隧道暴露的是前端 3100，
 *     故要补上前端反代到后端的同源前缀。
 *  3. 都没有 → null，调用方据此报「没有公网地址」而不是发一个 localhost 出去。
 */
@Injectable()
export class PublicUrlService {
  private readonly logger = new Logger(PublicUrlService.name);
  private cache?: { url: string | null; at: number };

  async baseUrl(): Promise<string | null> {
    const configured = process.env.PUBLIC_BASE_URL?.trim();
    if (configured) return stripSlash(configured);

    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.url;
    }
    const url = await this.probeNgrok();
    this.cache = { url, at: Date.now() };
    if (url) this.logger.log(`公网基址取自本机 ngrok 隧道：${url}`);
    return url;
  }

  /** 问本机 ngrok 要 https 隧道地址；没开隧道就是连不上，属正常情况，只留 debug 日志。 */
  private async probeNgrok(): Promise<string | null> {
    try {
      const res = await fetch(NGROK_API, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return pickHttpsTunnel(body);
    } catch (e) {
      this.logger.debug(
        `未探测到本机 ngrok 隧道：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 从 ngrok API 的响应里挑出 https 隧道地址。外部数据用 zod 解析成强类型（CLAUDE.md §8），
 * 形状不符就是「没探到隧道」，不抛错。
 * 隧道转发到前端端口时补上 `/api-backend`——那是前端反代到后端的路径前缀。
 */
const ngrokTunnelsSchema = z.object({
  tunnels: z
    .array(
      z.object({
        proto: z.string().optional(),
        public_url: z.string().optional(),
        config: z.object({ addr: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

export function pickHttpsTunnel(body: unknown): string | null {
  const parsed = ngrokTunnelsSchema.safeParse(body);
  if (!parsed.success) return null;
  for (const t of parsed.data.tunnels) {
    if (t.proto !== 'https' || !t.public_url) continue;
    const viaFrontend = t.config?.addr?.endsWith(`:${FRONTEND_PORT}`) ?? false;
    return (
      stripSlash(t.public_url) +
      (viaFrontend ? BACKEND_PREFIX_VIA_FRONTEND : '')
    );
  }
  return null;
}
