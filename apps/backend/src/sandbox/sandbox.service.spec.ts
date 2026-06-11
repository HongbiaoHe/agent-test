/**
 * SandboxStatusService 单测：只读状态查询的三态 + 降级行为。
 * mock agent/sandbox 的 pickUserSandbox/findUserSandbox/listWorkspaceFiles，不触真实 Daytona。
 */
import { SandboxStatusService } from './sandbox.service';

const mockPickUserSandbox = jest.fn();
const mockFindUserSandbox = jest.fn();
const mockListWorkspaceFiles = jest.fn();
jest.mock('../agent/sandbox', () => ({
  pickUserSandbox: (...args: unknown[]) => mockPickUserSandbox(...args),
  findUserSandbox: (...args: unknown[]) => mockFindUserSandbox(...args),
  listWorkspaceFiles: (...args: unknown[]) => mockListWorkspaceFiles(...args),
}));

describe('SandboxStatusService', () => {
  let service: SandboxStatusService;
  const KEY = process.env.DAYTONA_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DAYTONA_API_KEY = 'test-key';
    service = new SandboxStatusService();
  });

  afterAll(() => {
    if (KEY === undefined) delete process.env.DAYTONA_API_KEY;
    else process.env.DAYTONA_API_KEY = KEY;
  });

  it('无 DAYTONA_API_KEY → exists:false（不触 SDK）', async () => {
    delete process.env.DAYTONA_API_KEY;
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
      });
    mockFindUserSandbox.mockResolvedValue({ fake: true });
    mockListWorkspaceFiles.mockResolvedValue([{ path: 'a.txt' }]);

    const r = await service.status('u1', true);

    expect(r).toEqual({
      exists: true,
      id: 'sb-1',
      state: 'started',
      createdAt: '2026-06-11T01:00:00Z',
      updatedAt: '2026-06-11T02:00:00Z',
      autoStopMinutes: 5,
      autoDeleteMinutes: 30,
      files: [{ path: 'a.txt' }],
    });
  });

  it('started 默认（心跳）：不连沙箱不列文件——GET-by-id 会刷新 Daytona 活动事件导致永不自动停机', async () => {
    mockPickUserSandbox.mockResolvedValue({ id: 'sb-1', state: 'started', autoStopInterval: 5, autoDeleteInterval: 30 });

    const r = await service.status('u1');

    expect(r.exists).toBe(true);
    expect(r.state).toBe('started');
    expect(r.files).toBeNull();
    expect(mockFindUserSandbox).not.toHaveBeenCalled();
    expect(mockListWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('stopped：不连沙箱、不列文件（files:null），绝不唤醒', async () => {
    mockPickUserSandbox.mockResolvedValue({ id: 'sb-1', state: 'stopped', autoStopInterval: 5, autoDeleteInterval: 30 });

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
});
