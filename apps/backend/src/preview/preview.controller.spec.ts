jest.mock('../agent/sandbox-providers', () => ({}));
jest.mock('../agent/sandbox', () => ({}));
import { ErrorCodes } from '../common/errors/error-code';
import { PreviewController } from './preview.controller';
import type { PreviewSessionService } from './preview-session.service';

describe('PreviewController', () => {
  const user = { userId: 'u1', tenantId: 't1' } as never;
  const id = 'd'.repeat(32);
  let sessions: {
    createPort: jest.Mock;
    createFile: jest.Mock;
    upstream: jest.Mock;
    get: jest.Mock;
    revoke: jest.Mock;
    keepAlive: jest.Mock;
  };
  let ctrl: PreviewController;

  beforeEach(() => {
    process.env.PREVIEW_PROXY_BASE = 'http://localhost:3101';
    sessions = {
      createPort: jest.fn().mockResolvedValue(id),
      createFile: jest.fn().mockResolvedValue(id),
      get: jest.fn().mockResolvedValue({ u: 'u1', kind: 'file', root: '' }),
      revoke: jest.fn().mockResolvedValue(true),
      keepAlive: jest.fn().mockResolvedValue(undefined),
      upstream: jest
        .fn()
        .mockResolvedValue({ origin: 'https://x', headers: {} }),
    };
    ctrl = new PreviewController(sessions as unknown as PreviewSessionService);
  });
  afterEach(() => delete process.env.PREVIEW_PROXY_BASE);

  it('签发子域名地址并拼上应用内路径', async () => {
    expect(await ctrl.createPort(user, { port: 5173, path: '/about' })).toEqual(
      {
        id,
        url: `http://p-${id}.localhost:3101/about`,
      },
    );
    expect(sessions.createPort).toHaveBeenCalledWith('u1', 5173);
  });

  it('沙箱没在运行 → 签发时就报错（不让用户对着 404 的 iframe）', async () => {
    sessions.upstream.mockResolvedValueOnce(null);
    await expect(ctrl.createPort(user, { port: 5173 })).rejects.toMatchObject({
      errCode: ErrorCodes.PREVIEW_SANDBOX_NOT_RUNNING.code,
    });
  });

  it('提供方保留端口（E2B envd）→ 拒绝且不建会话', async () => {
    await expect(ctrl.createPort(user, { port: 49983 })).rejects.toMatchObject({
      errCode: ErrorCodes.PREVIEW_PORT_NOT_ALLOWED.code,
    });
    expect(sessions.createPort).not.toHaveBeenCalled();
  });

  describe('createFile（静态网页）', () => {
    it('站点根 = 入口所在目录，地址 = 子域名 + 入口文件名（与端口预览同一套子域名）', async () => {
      expect(
        await ctrl.createFile(user, { path: 'todo-vite/index.html' }),
      ).toEqual({ id, url: `http://p-${id}.localhost:3101/index.html` });
      expect(sessions.createFile).toHaveBeenCalledWith('u1', 'todo-vite');
    });

    it('工作区根下的页面 → 站点根为空；文件名做 URL 编码；容忍前导 /', async () => {
      expect(await ctrl.createFile(user, { path: '/首页 v2.html' })).toEqual({
        id,
        url: `http://p-${id}.localhost:3101/${encodeURIComponent('首页 v2.html')}`,
      });
      expect(sessions.createFile).toHaveBeenCalledWith('u1', '');
    });

    it('路径逃逸 → INVALID_PATH，不建会话', async () => {
      await expect(
        ctrl.createFile(user, { path: '../x/index.html' }),
      ).rejects.toMatchObject({ errCode: ErrorCodes.INVALID_PATH.code });
      expect(sessions.createFile).not.toHaveBeenCalled();
    });
  });

  describe('撤销 / 心跳', () => {
    it('撤销自己的会话 → revoked；别人的 / 不存在 / id 格式不对 → 404', async () => {
      expect(await ctrl.revoke(user, id)).toEqual({ revoked: true });
      expect(sessions.revoke).toHaveBeenCalledWith(id, 'u1');
      sessions.revoke.mockResolvedValueOnce(false);
      await expect(ctrl.revoke(user, id)).rejects.toMatchObject({
        errCode: ErrorCodes.PREVIEW_NOT_FOUND.code,
      });
      await expect(ctrl.revoke(user, 'not-an-id')).rejects.toMatchObject({
        errCode: ErrorCodes.PREVIEW_NOT_FOUND.code,
      });
    });

    it('心跳：自己的会话 → 续期沙箱；别人的会话 → 404 且不续期', async () => {
      expect(await ctrl.keepAlive(user, id)).toEqual({ ok: true });
      expect(sessions.keepAlive).toHaveBeenCalledWith('u1');
      sessions.keepAlive.mockClear();
      sessions.get.mockResolvedValueOnce({
        u: 'someone-else',
        kind: 'file',
        root: '',
      });
      await expect(ctrl.keepAlive(user, id)).rejects.toMatchObject({
        errCode: ErrorCodes.PREVIEW_NOT_FOUND.code,
      });
      expect(sessions.keepAlive).not.toHaveBeenCalled();
    });
  });
});
