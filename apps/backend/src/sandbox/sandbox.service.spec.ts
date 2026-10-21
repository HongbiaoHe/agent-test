/**
 * SandboxStatusService 单测：只读状态查询的三态 + 降级行为。
 * mock agent/sandbox 的 pickUserSandbox/findUserSandbox/listWorkspaceFiles，不触真实沙箱提供方。
 */
// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；偏好已整体 mock，不需要真实提供方
jest.mock('../agent/sandbox-providers', () => ({}));
import { ErrorCodes } from '../common/errors/error-code';
import type { SandboxSettingsService } from './sandbox-settings.service';
import { SandboxStatusService } from './sandbox.service';

const mockPickUserSandbox = jest.fn();
const mockFindUserSandbox = jest.fn();
const mockListWorkspaceFiles = jest.fn();
const mockStartUserDesktop = jest.fn();
const mockStopUserDesktop = jest.fn();
const mockReadRawFile = jest.fn();
const mockIsSandboxConfigured = jest.fn();
const mockGetUserSandbox = jest.fn();
jest.mock('../agent/sandbox', () => ({
  getUserSandbox: (...args: unknown[]) => mockGetUserSandbox(...args),
  isSandboxConfigured: (...args: unknown[]) => mockIsSandboxConfigured(...args),
  getSandboxProviderInfo: () => ({
    provider: 'daytona',
    desktopSupported: true,
  }),
  pickUserSandbox: (...args: unknown[]) => mockPickUserSandbox(...args),
  findUserSandbox: (...args: unknown[]) => mockFindUserSandbox(...args),
  listWorkspaceFiles: (...args: unknown[]) => mockListWorkspaceFiles(...args),
  startUserDesktop: (...args: unknown[]) => mockStartUserDesktop(...args),
  stopUserDesktop: (...args: unknown[]) => mockStopUserDesktop(...args),
  readRawFile: (...args: unknown[]) => mockReadRawFile(...args),
}));

describe('SandboxStatusService', () => {
  let service: SandboxStatusService;
  /** 设置 mock：该用户选了 e2b、闲置 15 分钟 */
  const config = {
    provider: 'e2b',
    lifecycle: { idleMinutes: 15, autoDeleteMinutes: 10 },
  };
  const prefs = {
    resolve: jest.fn().mockResolvedValue(config),
  } as unknown as SandboxSettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSandboxConfigured.mockReturnValue(true);
    service = new SandboxStatusService(prefs);
  });

  it('按用户偏好解析出的提供方查询（透传给 pickUserSandbox / isSandboxConfigured）', async () => {
    mockPickUserSandbox.mockResolvedValue(null);
    await service.status('u1');
    expect(prefs.resolve).toHaveBeenCalledWith('u1');
    expect(mockIsSandboxConfigured).toHaveBeenCalledWith('e2b');
    expect(mockPickUserSandbox).toHaveBeenCalledWith('u1', 'e2b');
  });

  it('列表不带闲置时长（E2B）→ autoStopMinutes 回退用户设置；文件列举透传完整配置', async () => {
    mockPickUserSandbox.mockResolvedValue({ id: 'sb-1', state: 'started' });
    mockFindUserSandbox.mockResolvedValue({ fake: true });
    mockListWorkspaceFiles.mockResolvedValue([]);
    const r = await service.status('u1', true);
    expect(r.autoStopMinutes).toBe(15);
    expect(r.autoDeleteMinutes).toBeNull();
    expect(mockFindUserSandbox).toHaveBeenCalledWith('u1', config);
  });

  it('规格字段：列表带 cpu/内存就透出，取不到的（E2B 无磁盘）为 null', async () => {
    mockPickUserSandbox.mockResolvedValue({
      id: 'sb-1',
      state: 'stopped',
      cpuCount: 2,
      memoryMB: 2048,
    });
    const r = await service.status('u1');
    expect([r.cpuCount, r.memoryMB, r.diskGB]).toEqual([2, 2048, null]);
  });

  it('start：走 getUserSandbox（停机拉起 / 没有则新建，透传完整配置），list 仍滞后报 stopped 时以连上为准', async () => {
    mockGetUserSandbox.mockResolvedValue({ fake: true });
    mockPickUserSandbox.mockResolvedValue({ id: 'sb-1', state: 'stopped' });
    const r = await service.start('u1');
    expect(mockGetUserSandbox).toHaveBeenCalledWith('u1', config);
    expect(r).toMatchObject({ exists: true, id: 'sb-1', state: 'started' });
  });

  it('start：提供方未配置 → SANDBOX_PROVIDER_NOT_CONFIGURED，不触 SDK', async () => {
    mockIsSandboxConfigured.mockReturnValue(false);
    await expect(service.start('u1')).rejects.toMatchObject({
      errCode: ErrorCodes.SANDBOX_PROVIDER_NOT_CONFIGURED.code,
    });
    expect(mockGetUserSandbox).not.toHaveBeenCalled();
  });

  it('当前提供方未配置凭据 → exists:false（不触 SDK）', async () => {
    mockIsSandboxConfigured.mockReturnValue(false);
    expect(await service.status('u1')).toEqual({ exists: false });
    expect(mockPickUserSandbox).not.toHaveBeenCalled();
  });

  it('无沙箱 → exists:false', async () => {
    mockPickUserSandbox.mockResolvedValue(null);
    expect(await service.status('u1')).toEqual({ exists: false });
  });

  it('started + includeFiles：字段映射完整 + 列工作区文件', async () => {
    mockPickUserSandbox.mockResolvedValue({
      id: 'sb-1',
      state: 'started',
      createdAt: '2026-06-11T01:00:00Z',
      updatedAt: '2026-06-11T02:00:00Z',
      autoStopInterval: 5,
      autoDeleteInterval: 30,
      cpuCount: 1,
      memoryMB: 1024,
      diskGB: 3,
    });
    mockFindUserSandbox.mockResolvedValue({ fake: true });
    mockListWorkspaceFiles.mockResolvedValue([{ path: 'a.txt' }]);

    const r = await service.status('u1', true);

    expect(r).toEqual({
      exists: true,
      provider: 'daytona',
      desktopSupported: true,
      id: 'sb-1',
      state: 'started',
      createdAt: '2026-06-11T01:00:00Z',
      updatedAt: '2026-06-11T02:00:00Z',
      autoStopMinutes: 5,
      autoDeleteMinutes: 30,
      cpuCount: 1,
      memoryMB: 1024,
      diskGB: 3,
      files: [{ path: 'a.txt' }],
    });
  });

  it('started 默认（心跳）：不连沙箱不列文件——GET-by-id 会刷新 Daytona 活动事件导致永不自动停机', async () => {
    mockPickUserSandbox.mockResolvedValue({
      id: 'sb-1',
      state: 'started',
      autoStopInterval: 5,
      autoDeleteInterval: 30,
    });

    const r = await service.status('u1');

    expect(r.exists).toBe(true);
    expect(r.state).toBe('started');
    expect(r.files).toBeNull();
    expect(mockFindUserSandbox).not.toHaveBeenCalled();
    expect(mockListWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('stopped：不连沙箱、不列文件（files:null），绝不唤醒', async () => {
    mockPickUserSandbox.mockResolvedValue({
      id: 'sb-1',
      state: 'stopped',
      autoStopInterval: 5,
      autoDeleteInterval: 30,
    });

    const r = await service.status('u1');

    expect(r.exists).toBe(true);
    expect(r.state).toBe('stopped');
    expect(r.files).toBeNull();
    expect(mockFindUserSandbox).not.toHaveBeenCalled();
  });

  it('started + includeFiles 但文件列举失败 → 状态主体不受影响（files:null）', async () => {
    mockPickUserSandbox.mockResolvedValue({ id: 'sb-1', state: 'started' });
    mockFindUserSandbox.mockRejectedValue(new Error('boom'));

    const r = await service.status('u1', true);

    expect(r.exists).toBe(true);
    expect(r.files).toBeNull();
  });

  it('查询抛错 → 降级 exists:false（不向上抛）', async () => {
    mockPickUserSandbox.mockRejectedValue(new Error('network'));
    expect(await service.status('u1')).toEqual({ exists: false });
  });

  describe('desktop', () => {
    it('startDesktop：helper 返回 url → 原样返回', async () => {
      mockStartUserDesktop.mockResolvedValue(
        'https://x/vnc.html?autoconnect=true&resize=scale',
      );
      expect(await service.startDesktop('u1')).toEqual({
        url: 'https://x/vnc.html?autoconnect=true&resize=scale',
      });
      expect(mockStartUserDesktop).toHaveBeenCalledWith('u1', 'e2b');
    });

    it('startDesktop：helper 返回 null（无沙箱/未运行）→ SANDBOX_NOT_RUNNING', async () => {
      mockStartUserDesktop.mockResolvedValue(null);
      await expect(service.startDesktop('u1')).rejects.toMatchObject({
        errCode: 40008,
      });
    });

    it('stopDesktop：透传 helper 且不抛错', async () => {
      mockStopUserDesktop.mockResolvedValue(undefined);
      await expect(service.stopDesktop('u1')).resolves.toBeUndefined();
      expect(mockStopUserDesktop).toHaveBeenCalledWith('u1', 'e2b');
    });
  });
  describe('readRaw（播放/下载原始字节）', () => {
    const video = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

    beforeEach(() => {
      mockFindUserSandbox.mockResolvedValue({ fake: true });
      mockReadRawFile.mockResolvedValue(video);
    });

    it('无 Range → 200 全量，视频可内联，带安全头', async () => {
      const r = await service.readRaw('u1', 'out/a.mp4', undefined, false);
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(100);
      expect(r.headers['Content-Type']).toBe('video/mp4');
      expect(r.headers['Content-Disposition']).toMatch(/^inline;/);
      expect(r.headers['Accept-Ranges']).toBe('bytes');
      expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(mockFindUserSandbox).toHaveBeenCalledWith('u1', config);
    });

    it('Range → 206 + Content-Range + 对应切片', async () => {
      const r = await service.readRaw('u1', 'out/a.mp4', 'bytes=10-19', false);
      expect(r.status).toBe(206);
      expect(r.headers['Content-Range']).toBe('bytes 10-19/100');
      expect(Array.from(r.body)).toEqual([
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ]);
    });

    it('越界 Range → 416', async () => {
      const r = await service.readRaw('u1', 'out/a.mp4', 'bytes=200-', false);
      expect(r.status).toBe(416);
      expect(r.headers['Content-Range']).toBe('bytes */100');
    });

    it('download=1 → attachment；HTML 即使不下载也强制 attachment', async () => {
      const d = await service.readRaw('u1', 'out/a.mp4', undefined, true);
      expect(d.headers['Content-Disposition']).toMatch(/^attachment;/);
      const h = await service.readRaw(
        'u1',
        'site/index.html',
        undefined,
        false,
      );
      expect(h.headers['Content-Disposition']).toMatch(/^attachment;/);
    });

    it('续传 Range 走缓存不回源；从头请求总是回源（拿到最新内容）', async () => {
      await service.readRaw('u1', 'out/a.mp4', 'bytes=0-', false);
      await service.readRaw('u1', 'out/a.mp4', 'bytes=50-', false);
      expect(mockReadRawFile).toHaveBeenCalledTimes(1);
      await service.readRaw('u1', 'out/a.mp4', 'bytes=0-', false);
      expect(mockReadRawFile).toHaveBeenCalledTimes(2);
    });

    it('文件不存在 → SANDBOX_NOT_FOUND；路径逃逸 → INVALID_PATH', async () => {
      mockReadRawFile.mockRejectedValue(new Error('file_not_found'));
      await expect(
        service.readRaw('u1', 'nope.mp4', undefined, false),
      ).rejects.toMatchObject({ errCode: ErrorCodes.SANDBOX_NOT_FOUND.code });
      await expect(
        service.readRaw('u1', '../etc/passwd', undefined, false),
      ).rejects.toMatchObject({ errCode: ErrorCodes.INVALID_PATH.code });
    });

    it('无沙箱 → SANDBOX_NOT_FOUND', async () => {
      mockFindUserSandbox.mockResolvedValue(null);
      await expect(
        service.readRaw('u1', 'out/a.mp4', undefined, false),
      ).rejects.toMatchObject({ errCode: ErrorCodes.SANDBOX_NOT_FOUND.code });
    });
  });
});
