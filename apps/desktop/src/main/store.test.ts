import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// safeStorage 的替身：「enc:」前缀的才是本机加密的密文，其余（别处拷来 / 钥匙串被重置）一律解密失败
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
    decryptString: (buf: Buffer) => {
      const text = buf.toString();
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return text.slice(4);
    },
  },
}));

const { DesktopStore } = await import('./store');

const foreign = Buffer.from('ciphertext from another keychain').toString('base64');
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('DesktopStore：解不开的密文按未配置处理', () => {
  it('连接 Key 解不开：按未配置处理、不交给 agent-host；重新填写后恢复；清除即删掉', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(join(dir, 'model-keys.json'), JSON.stringify({ keys: { c1: foreign } }));
    const store = new DesktopStore(dir);
    expect(store.connectionKeyStatus()).toEqual({});
    expect(store.modelKeys()).toEqual({});
    expect(store.setConnectionKey('c1', ' sk-test ')).toEqual({ c1: true });
    expect(store.modelKeys()).toEqual({ c1: 'sk-test' });
    expect(store.setConnectionKey('c1', null)).toEqual({});
  });

  it('Web 令牌解不开：视为未登录，数据目录回到访客空间', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({ webToken: foreign, webEmail: 'a@b.test', webApiUrl: 'http://localhost:3101' }),
    );
    const store = new DesktopStore(dir);
    expect(store.webAccount().signedIn).toBe(false);
    expect(store.webToken()).toBeNull();
    expect(store.profileDir()).toBe(dir);
  });

  it('MCP 密钥解不开：重新生成一把并保存，之后稳定返回同一把', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ mcpKey: foreign }));
    const store = new DesktopStore(dir);
    const key = store.mcpEncryptionKey();
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(store.mcpEncryptionKey()).toBe(key);
    const saved: unknown = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    expect(saved).toMatchObject({ mcpKey: Buffer.from(`enc:${key}`).toString('base64') });
  });
});

describe('DesktopStore：API 连接 Key 按账号隔离 + 旧版设备级 Key 迁移', () => {
  /** 已登录：profileDir 指向 users/<sub>（JWT 载荷里的 sub） */
  function signIn(store: InstanceType<typeof DesktopStore>, sub: string) {
    const payload = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    store.setWebSession(`${sub}@x.test`, `h.${payload}.s`, store.getSettings().webApiUrl);
  }
  const enc = (plain: string) => Buffer.from(`enc:${plain}`).toString('base64');

  it('不同账号各存各的 Key，互相看不到', () => {
    const store = new DesktopStore(dir);
    store.setConnectionKey('guest-conn', 'k-guest');
    signIn(store, 'u1');
    expect(store.modelKeys()).toEqual({});
    store.setConnectionKey('u1-conn', 'k-u1');
    expect(store.modelKeys()).toEqual({ 'u1-conn': 'k-u1' });
    store.clearWebSession();
    expect(store.modelKeys()).toEqual({ 'guest-conn': 'k-guest' });
  });

  it('旧 Key 迁进当前账号（生成连接 id、复制 Key）；同一账号再调返回同一份；所有已知账号迁完才删设备级旧 Key', async () => {
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ google: enc('AIza-old'), deepseek: enc('sk-old') }));
    const store = new DesktopStore(dir);
    // 本机还有一个之前登录过的账号目录：它没迁之前不能删旧 Key
    await mkdir(join(dir, 'users', 'u2'), { recursive: true });

    const guest = store.migrateLegacyKeys();
    expect(guest.map((c) => c.presetId)).toEqual(['gemini', 'deepseek']);
    expect(Object.values(store.modelKeys()).sort()).toEqual(['AIza-old', 'sk-old']);
    expect(store.migrateLegacyKeys()).toEqual(guest);
    let secrets: unknown = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    expect(secrets).toMatchObject({ google: enc('AIza-old'), deepseek: enc('sk-old') });

    signIn(store, 'u2');
    const u2 = store.migrateLegacyKeys();
    expect(u2).toHaveLength(2);
    expect(u2[0].id).not.toBe(guest[0].id);
    secrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    expect(secrets).not.toHaveProperty('google');
    expect(secrets).not.toHaveProperty('deepseek');

    // 旧 Key 删掉之后才第一次打开的账号：没有可迁的，记为已迁（空列表），需要自己配
    signIn(store, 'u3');
    expect(store.migrateLegacyKeys()).toEqual([]);
  });
});
