import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('模型 Key 解不开：状态为未配置、不交给 agent-host；重新填写后恢复', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ google: foreign, deepseek: foreign }));
    const store = new DesktopStore(dir);
    expect(store.keyStatus()).toEqual({ google: false, deepseek: false });
    expect(store.keys()).toEqual({});
    expect(store.setKey('google', 'AIza-test')).toEqual({ google: true, deepseek: false });
    expect(store.keys()).toEqual({ google: 'AIza-test' });
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
