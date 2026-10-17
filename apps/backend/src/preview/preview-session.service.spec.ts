jest.mock('../agent/sandbox-providers', () => ({}));
const mockGetUserPortUpstream = jest.fn();
const mockFindUserSandbox = jest.fn();
const mockKeepUserSandboxAlive = jest.fn();
jest.mock('../agent/sandbox', () => ({
  getUserPortUpstream: (...a: unknown[]) => mockGetUserPortUpstream(...a),
  findUserSandbox: (...a: unknown[]) => mockFindUserSandbox(...a),
  keepUserSandboxAlive: (...a: unknown[]) => mockKeepUserSandboxAlive(...a),
}));
import type { Redis } from 'ioredis';
import type { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import {
  PREVIEW_IDLE_TTL_S,
  PREVIEW_MAX_LIFETIME_MS,
  PreviewSessionService,
} from './preview-session.service';

/** 内存版 Redis：只实现用到的 set/get/expire/del，记录 TTL。 */
function fakeRedis() {
  const store = new Map<string, { v: string; ttl: number }>();
  const redis = {
    set: jest.fn((k: string, v: string, _ex: string, ttl: number) => {
      store.set(k, { v, ttl });
      return Promise.resolve('OK');
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k)?.v ?? null)),
    expire: jest.fn((k: string, ttl: number) => {
      const e = store.get(k);
      if (e) e.ttl = ttl;
      return Promise.resolve(e ? 1 : 0);
    }),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
  return { redis, store };
}

describe('PreviewSessionService', () => {
  const config = { provider: 'e2b', lifecycle: { idleMinutes: 5 } };
  const settings = {
    resolve: jest.fn().mockResolvedValue(config),
  } as unknown as SandboxSettingsService;
  const upstream = { origin: 'https://5173-sb.proxy', headers: { t: 'S' } };

  function setup() {
    const { redis, store } = fakeRedis();
    const svc = new PreviewSessionService(redis as unknown as Redis, settings);
    return { svc, redis, store };
  }

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockGetUserPortUpstream.mockResolvedValue(upstream);
    mockFindUserSandbox.mockResolvedValue({ sb: 1 });
    mockKeepUserSandboxAlive.mockResolvedValue(undefined);
  });

  describe('签发与复用', () => {
    it('端口 / 文件会话：32 位 hex id，带类型与绝对到期时刻存 Redis，TTL = 闲置期', async () => {
      const { svc, store } = setup();
      const before = Date.now();
      const p = await svc.createPort('u1', 5173);
      const f = await svc.createFile('u1', 'todo-vite');
      expect(p).toMatch(/^[a-f0-9]{32}$/);
      const port = JSON.parse(store.get(`preview:${p}`)!.v);
      expect(port).toMatchObject({ u: 'u1', kind: 'port', port: 5173 });
      expect(port.exp).toBeGreaterThanOrEqual(before + PREVIEW_MAX_LIFETIME_MS);
      expect(JSON.parse(store.get(`preview:${f}`)!.v)).toMatchObject({
        kind: 'file',
        root: 'todo-vite',
      });
      expect(store.get(`preview:${f}`)!.ttl).toBe(PREVIEW_IDLE_TTL_S);
    });

    it('上限内重复打开同一内容 → 同一 id（同一个源，页面存储保留）；不同内容 / 不同用户 → 不同 id', async () => {
      const { svc } = setup();
      const a = await svc.createFile('u1', 'todo-vite');
      expect(await svc.createFile('u1', 'todo-vite')).toBe(a);
      expect(await svc.createFile('u1', 'other')).not.toBe(a);
      expect(await svc.createFile('u2', 'todo-vite')).not.toBe(a);
      const p = await svc.createPort('u1', 5173);
      expect(await svc.createPort('u1', 5173)).toBe(p);
      expect(await svc.createPort('u1', 3000)).not.toBe(p);
    });

    it('会话已失效（闲置过期 / 被重置）→ 再打开签发新 id', async () => {
      const { svc, store } = setup();
      const a = await svc.createFile('u1', 'site');
      store.delete(`preview:${a}`);
      expect(await svc.createFile('u1', 'site')).not.toBe(a);
    });
  });

  describe('有效期', () => {
    it('到绝对上限必失效：即使期间一直有人访问（滑动续期不能突破上限）', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      const { svc, store } = setup();
      const id = await svc.createFile('u1', 'site');
      expect(await svc.get(id)).not.toBeNull();
      jest.setSystemTime(1_000_000 + PREVIEW_MAX_LIFETIME_MS + 1);
      expect(await svc.get(id)).toBeNull();
      expect(store.has(`preview:${id}`)).toBe(false);
      // 到期后再打开 → 新地址
      expect(await svc.createFile('u1', 'site')).not.toBe(id);
    });

    it('续期的 TTL 不超过离绝对上限的剩余时间', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      const { svc, store } = setup();
      const id = await svc.createFile('u1', 'site');
      jest.setSystemTime(1_000_000 + PREVIEW_MAX_LIFETIME_MS - 600_000);
      await svc.get(id);
      expect(store.get(`preview:${id}`)!.ttl).toBe(600);
    });

    it('没有 exp 的旧格式会话一律视为失效（安全默认）', async () => {
      const { svc, store } = setup();
      store.set('preview:old', {
        v: '{"u":"u1","kind":"port","port":3000}',
        ttl: 1,
      });
      expect(await svc.get('old')).toBeNull();
    });
  });

  describe('撤销（重置预览）', () => {
    it('撤销自己的会话 → 地址立即失效，同一内容下次打开换新 id', async () => {
      const { svc } = setup();
      const id = await svc.createFile('u1', 'site');
      expect(await svc.revoke(id, 'u1')).toBe(true);
      expect(await svc.get(id)).toBeNull();
      expect(await svc.createFile('u1', 'site')).not.toBe(id);
    });

    it('不能撤销别人的会话 / 不存在的会话', async () => {
      const { svc } = setup();
      const id = await svc.createFile('u1', 'site');
      expect(await svc.revoke(id, 'u2')).toBe(false);
      expect(await svc.get(id)).not.toBeNull();
      expect(await svc.revoke('f'.repeat(32), 'u1')).toBe(false);
    });
  });

  describe('续期沙箱（keepAlive）', () => {
    it('带用户设置续期；同一用户 60s 内只续一次，之后再续', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      const { svc } = setup();
      await svc.keepAlive('u1');
      await svc.keepAlive('u1');
      expect(mockKeepUserSandboxAlive).toHaveBeenCalledTimes(1);
      expect(mockKeepUserSandboxAlive).toHaveBeenCalledWith('u1', config);
      jest.setSystemTime(1_000_000 + 61_000);
      await svc.keepAlive('u1');
      expect(mockKeepUserSandboxAlive).toHaveBeenCalledTimes(2);
    });

    it('续期失败只记日志，不向上抛（不能让预览请求因此失败）', async () => {
      const { svc } = setup();
      mockKeepUserSandboxAlive.mockRejectedValueOnce(new Error('network'));
      await expect(svc.keepAlive('u1')).resolves.toBeUndefined();
    });
  });

  describe('端口上游', () => {
    it('按会话的用户、端口与用户偏好的提供方解析；5 分钟内复用缓存但仍续期会话', async () => {
      const { svc, redis } = setup();
      const id = await svc.createPort('u1', 5173);
      redis.expire.mockClear();
      expect(await svc.upstream(id)).toBe(upstream);
      expect(await svc.upstream(id)).toBe(upstream);
      expect(mockGetUserPortUpstream).toHaveBeenCalledTimes(1);
      expect(mockGetUserPortUpstream).toHaveBeenCalledWith('u1', 5173, 'e2b');
      expect(redis.expire).toHaveBeenCalledTimes(2);
    });

    it('fresh=true 跳过缓存重新解析（上游连不上时用）', async () => {
      const { svc } = setup();
      const id = await svc.createPort('u1', 5173);
      await svc.upstream(id);
      await svc.upstream(id, true);
      expect(mockGetUserPortUpstream).toHaveBeenCalledTimes(2);
    });

    it('文件会话 / 会话不存在 → null，不碰提供方；沙箱没在运行 → null 且不缓存', async () => {
      const { svc } = setup();
      expect(await svc.upstream(await svc.createFile('u1', 'site'))).toBeNull();
      expect(await svc.upstream('f'.repeat(32))).toBeNull();
      expect(mockGetUserPortUpstream).not.toHaveBeenCalled();
      const id = await svc.createPort('u1', 5173);
      mockGetUserPortUpstream.mockResolvedValueOnce(null);
      expect(await svc.upstream(id)).toBeNull();
      expect(await svc.upstream(id)).toBe(upstream);
    });
  });

  describe('文件会话的沙箱句柄', () => {
    it('按用户缓存（一个页面的多个资源只连一次）；fresh 强制重连；没有沙箱不缓存', async () => {
      const { svc } = setup();
      expect(await svc.sandboxFor('u1')).toEqual({ sb: 1 });
      await svc.sandboxFor('u1');
      expect(mockFindUserSandbox).toHaveBeenCalledTimes(1);
      await svc.sandboxFor('u1', true);
      expect(mockFindUserSandbox).toHaveBeenCalledTimes(2);
      mockFindUserSandbox.mockResolvedValueOnce(null);
      expect(await svc.sandboxFor('u2')).toBeNull();
      expect(await svc.sandboxFor('u2')).toEqual({ sb: 1 });
    });
  });
});
