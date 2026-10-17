import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  findUserSandbox,
  getUserPortUpstream,
  keepUserSandboxAlive,
  type PortUpstream,
} from '../agent/sandbox';
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SandboxSettingsService } from '../sandbox/sandbox-settings.service';

/**
 * 预览会话：哪个用户的什么内容。两种都挂在同一套子域名反代上（见 PreviewProxy）：
 * - port：沙箱里运行中的服务，请求转发到提供方的端口地址；
 * - file：工作区里的静态网页，root = 站点根目录（工作区相对路径，'' = 工作区根），
 *   请求按路径直接读沙箱文件。
 * exp = 绝对到期时刻（epoch ms）：到点必失效，不管期间是否一直有人访问。
 */
export type PreviewSession =
  | { u: string; kind: 'port'; port: number; exp: number }
  | { u: string; kind: 'file'; root: string; exp: number };

type NewSession =
  | { u: string; kind: 'port'; port: number }
  | { u: string; kind: 'file'; root: string };

/**
 * 有效期两道闸：
 * - 绝对上限 24h：预览地址本身就是访问凭证（iframe 带不了登录态），上限决定它泄露后最多能用多久；
 * - 闲置 2h：这么久没人访问就提前失效。
 * 上限内对同一内容重复打开会复用同一个会话（同一个源），页面的 localStorage 等存储得以保留。
 */
export const PREVIEW_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_IDLE_TTL_S = 2 * 60 * 60;
/** 上游地址 / 沙箱句柄缓存：提供方 SDK 查询要 0.5~4s，不能每个资源请求都查一遍。 */
const CACHE_MS = 5 * 60 * 1000;
/** 续期节流：同一用户 60s 内最多续一次（续期本身就要调提供方 API）。 */
const KEEPALIVE_THROTTLE_MS = 60_000;

const key = (id: string) => `preview:${id}`;
/** 「同一用户的同一内容」→ 会话 id，用来复用会话。 */
const indexKey = (s: NewSession) =>
  `preview:idx:${s.u}:${s.kind}:${s.kind === 'port' ? s.port : s.root}`;

function parseSession(v: unknown): PreviewSession | null {
  if (
    !v ||
    typeof v !== 'object' ||
    !('u' in v) ||
    typeof v.u !== 'string' ||
    !('exp' in v) ||
    typeof v.exp !== 'number'
  ) {
    // 没有 exp 的旧格式一律视为失效：安全默认，重新打开即可
    return null;
  }
  if ('kind' in v && v.kind === 'file') {
    return 'root' in v && typeof v.root === 'string'
      ? { u: v.u, kind: 'file', root: v.root, exp: v.exp }
      : null;
  }
  return 'kind' in v &&
    v.kind === 'port' &&
    'port' in v &&
    typeof v.port === 'number'
    ? { u: v.u, kind: 'port', port: v.port, exp: v.exp }
    : null;
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/**
 * 预览会话：id → 会话存 Redis（后端重启/多实例都认得）。上游地址（含提供方访问令牌）与
 * 沙箱句柄只缓存在进程内存，从不出后端。
 */
@Injectable()
export class PreviewSessionService {
  private readonly logger = new Logger(PreviewSessionService.name);
  private readonly upstreams = new Map<string, Cached<PortUpstream>>();
  private readonly sandboxes = new Map<string, Cached<GuardedSandbox>>();
  private readonly lastKeepAlive = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly settings: SandboxSettingsService,
  ) {}

  createPort(userId: string, port: number): Promise<string> {
    return this.reuseOrCreate({ u: userId, kind: 'port', port });
  }

  createFile(userId: string, root: string): Promise<string> {
    return this.reuseOrCreate({ u: userId, kind: 'file', root });
  }

  /** 上限内已有同一内容的会话就复用（同一个源，存储保留），否则新建。 */
  private async reuseOrCreate(session: NewSession): Promise<string> {
    const idx = indexKey(session);
    const existing = await this.redis.get(idx);
    if (existing && (await this.get(existing))) return existing;

    const id = randomBytes(16).toString('hex');
    const exp = Date.now() + PREVIEW_MAX_LIFETIME_MS;
    await this.redis.set(
      key(id),
      JSON.stringify({ ...session, exp }),
      'EX',
      ttlFor(exp),
    );
    await this.redis.set(
      idx,
      id,
      'EX',
      Math.ceil(PREVIEW_MAX_LIFETIME_MS / 1000),
    );
    return id;
  }

  /** 会话不存在 / 已过期（闲置或到绝对上限）→ null。命中则续闲置期（不超过绝对上限）。 */
  async get(id: string): Promise<PreviewSession | null> {
    const raw = await this.redis.get(key(id));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const session = parseSession(parsed);
    if (!session || session.exp <= Date.now()) {
      await this.redis.del(key(id));
      return null;
    }
    await this.redis.expire(key(id), ttlFor(session.exp));
    return session;
  }

  /**
   * 撤销（「重置预览」）：只能撤销自己的会话。地址立刻失效；同一内容下次打开会拿到新的会话、
   * 新的源，旧源下的存储不再被使用。
   */
  async revoke(id: string, userId: string): Promise<boolean> {
    const session = await this.get(id);
    if (!session || session.u !== userId) return false;
    await this.redis.del(key(id));
    const idx = indexKey(session);
    if ((await this.redis.get(idx)) === id) await this.redis.del(idx);
    this.upstreams.delete(id);
    return true;
  }

  /**
   * 预览使用中：让用户的沙箱保持活跃（节流，失败只记日志——续期失败不该让预览请求失败）。
   * 反代每个请求、前端弹窗心跳都会调它。
   */
  async keepAlive(userId: string): Promise<void> {
    const last = this.lastKeepAlive.get(userId) ?? 0;
    if (Date.now() - last < KEEPALIVE_THROTTLE_MS) return;
    this.lastKeepAlive.set(userId, Date.now());
    try {
      await keepUserSandboxAlive(userId, await this.settings.resolve(userId));
    } catch (e) {
      this.logger.warn(`预览续期失败 userId=${userId}: ${String(e)}`);
    }
  }

  /**
   * 端口会话 → 上游。会话不存在 / 不是端口会话 / 沙箱没在运行 → null
   * （预览不负责拉起停机沙箱）。fresh=true 跳过缓存重新解析（上游连不上时用：沙箱可能重建过）。
   */
  async upstream(id: string, fresh = false): Promise<PortUpstream | null> {
    const cached = this.upstreams.get(id);
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      // 缓存命中也要确认会话没过期（并顺带续期）
      return (await this.get(id)) ? cached.value : null;
    }
    const session = await this.get(id);
    if (!session || session.kind !== 'port') return null;
    const config = await this.settings.resolve(session.u);
    const upstream = await getUserPortUpstream(
      session.u,
      session.port,
      config.provider,
    );
    if (upstream) {
      this.upstreams.set(id, {
        value: upstream,
        expiresAt: Date.now() + CACHE_MS,
      });
    } else {
      this.upstreams.delete(id);
    }
    return upstream;
  }

  /**
   * 文件会话要读的用户沙箱（按用户缓存：一个页面的 html/js/css/图片同时来，不能各连一次沙箱）。
   * 停机则唤醒——用户正打开预览，续命可接受。fresh=true 跳过缓存（读失败时重连一次：
   * 沙箱可能停机重建过，旧句柄已失效）。
   */
  async sandboxFor(
    userId: string,
    fresh = false,
  ): Promise<GuardedSandbox | null> {
    const cached = this.sandboxes.get(userId);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const sb = await findUserSandbox(
      userId,
      await this.settings.resolve(userId),
    );
    if (sb) {
      this.sandboxes.set(userId, {
        value: sb,
        expiresAt: Date.now() + CACHE_MS,
      });
    } else {
      this.sandboxes.delete(userId);
    }
    return sb;
  }
}

/** Redis TTL：闲置期，但不超过离绝对上限的剩余时间。 */
function ttlFor(exp: number): number {
  return Math.max(
    1,
    Math.min(PREVIEW_IDLE_TTL_S, Math.ceil((exp - Date.now()) / 1000)),
  );
}
