/**
 * SandboxSettingsService 单测：提供方回退规则、生命周期默认值、局部更新、
 * 未配置提供方拒绝、保存后把生命周期应用到现有沙箱（失败不影响保存）。
 * 提供方 SDK 为深 ESM 链，mock 掉 sandbox-providers / agent/sandbox。
 */
const configured: Record<string, boolean> = { daytona: true, e2b: true };
/** 能否按沙箱设置出站（Daytona 取决于账户等级，按用例切换） */
const egressControl: Record<string, boolean> = { daytona: true, e2b: true };
const applyLifecycle = jest.fn();
const applyEgress = jest.fn();
const inspectPublicTraffic = jest.fn();
jest.mock('../agent/sandbox-providers', () => ({
  DEFAULT_SANDBOX_LIFECYCLE: { idleMinutes: 5, autoDeleteMinutes: 10 },
  DEFAULT_SANDBOX_NETWORK: {
    egress: 'open',
    allowList: [],
    publicTraffic: false,
  },
  SANDBOX_EGRESS_MODES: ['open', 'allowlist', 'blocked'],
  SandboxNetworkUnsupportedError: class SandboxNetworkUnsupportedError extends Error {},
  normalizeAllowList: (l: string[]) => l.map((e) => e.trim().toLowerCase()),
  defaultSandboxProviderName: () => 'daytona',
  isSandboxProviderName: (v: string) => v === 'daytona' || v === 'e2b',
  getSandboxProvider: (name: string) => ({
    name,
    isConfigured: () => configured[name],
    supportsEgressControl: egressControl[name],
    applyLifecycle,
    applyEgress,
    inspectPublicTraffic,
    // 指纹口径简化：直接用 egress 模式名
    desiredEgress: (n: { egress: string }) => n.egress,
  }),
  listSandboxProviders: () => [
    {
      name: 'daytona',
      isConfigured: () => configured.daytona,
      desktop: {},
      supportsAutoDelete: true,
      supportsEgressControl: false,
      supportsDomainAllowList: false,
      supportsPublicTrafficToggle: false,
    },
    {
      name: 'e2b',
      isConfigured: () => configured.e2b,
      supportsAutoDelete: false,
      supportsEgressControl: true,
      supportsDomainAllowList: true,
      supportsPublicTrafficToggle: true,
    },
  ],
}));
const mockPickUserSandbox = jest.fn();
jest.mock('../agent/sandbox', () => ({
  pickUserSandbox: (...args: unknown[]) => mockPickUserSandbox(...args),
}));

import { SandboxNetworkUnsupportedError } from '../agent/sandbox-providers';
import { ErrorCodes } from '../common/errors/error-code';
import type { PrismaService } from '../prisma/prisma.service';
import { SandboxSettingsService } from './sandbox-settings.service';

const row = (
  over: Partial<{
    sandboxProvider: string | null;
    sandboxIdleMinutes: number | null;
    sandboxAutoDeleteMinutes: number | null;
    sandboxNetworkMode: string | null;
    sandboxNetworkAllowList: unknown;
    sandboxPublicTraffic: boolean | null;
  }> = {},
) => ({
  sandboxProvider: null,
  sandboxIdleMinutes: null,
  sandboxAutoDeleteMinutes: null,
  sandboxNetworkMode: null,
  sandboxNetworkAllowList: null,
  sandboxPublicTraffic: null,
  ...over,
});

const OPEN = { egress: 'open', allowList: [], publicTraffic: false };

describe('SandboxSettingsService', () => {
  const findUnique = jest.fn();
  const update = jest.fn().mockResolvedValue({});
  const prisma = { user: { findUnique, update } } as unknown as PrismaService;
  const svc = new SandboxSettingsService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    configured.daytona = true;
    configured.e2b = true;
    egressControl.daytona = true;
    egressControl.e2b = true;
  });

  it('全未设置 → env 默认提供方 + 默认生命周期', async () => {
    findUnique.mockResolvedValue(row());
    expect(await svc.resolve('u1')).toEqual({
      provider: 'daytona',
      lifecycle: { idleMinutes: 5, autoDeleteMinutes: 10 },
      network: OPEN,
    });
  });

  it('用户设置生效：e2b + 闲置 30 分钟 + 永不删除', async () => {
    findUnique.mockResolvedValue(
      row({
        sandboxProvider: 'e2b',
        sandboxIdleMinutes: 30,
        sandboxAutoDeleteMinutes: -1,
      }),
    );
    expect(await svc.resolve('u1')).toEqual({
      provider: 'e2b',
      lifecycle: { idleMinutes: 30, autoDeleteMinutes: -1 },
      network: OPEN,
    });
  });

  it('偏好 e2b 但服务端撤了 key → 回退默认（不让整轮无沙箱）', async () => {
    configured.e2b = false;
    findUnique.mockResolvedValue(row({ sandboxProvider: 'e2b' }));
    expect((await svc.resolve('u1')).provider).toBe('daytona');
  });

  it('库里脏值（非法名）→ 按未设置处理', async () => {
    findUnique.mockResolvedValue(row({ sandboxProvider: 'docker' }));
    const s = await svc.getSettings('u1');
    expect(s.preference).toBeNull();
    expect(s.current).toBe('daytona');
  });

  it('getSettings：列出提供方能力与默认生命周期', async () => {
    configured.e2b = false;
    findUnique.mockResolvedValue(row());
    expect(await svc.getSettings('u1')).toEqual({
      current: 'daytona',
      preference: null,
      default: 'daytona',
      providers: [
        {
          name: 'daytona',
          configured: true,
          desktopSupported: true,
          supportsAutoDelete: true,
          supportsEgressControl: false,
          supportsDomainAllowList: false,
          supportsPublicTrafficToggle: false,
        },
        {
          name: 'e2b',
          configured: false,
          desktopSupported: false,
          supportsAutoDelete: false,
          supportsEgressControl: true,
          supportsDomainAllowList: true,
          supportsPublicTrafficToggle: true,
        },
      ],
      lifecycle: { idleMinutes: 5, autoDeleteMinutes: 10 },
      lifecycleDefaults: { idleMinutes: 5, autoDeleteMinutes: 10 },
      network: OPEN,
      networkDefaults: OPEN,
      currentPublicTraffic: null,
    });
  });

  it('只切提供方：只写 sandboxProvider，不动生命周期、不应用到沙箱', async () => {
    findUnique.mockResolvedValue(row({ sandboxProvider: 'e2b' }));
    const s = await svc.update('u1', { provider: 'e2b' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { sandboxProvider: 'e2b' },
    });
    expect(s.current).toBe('e2b');
    expect(applyLifecycle).not.toHaveBeenCalled();
  });

  it('provider: null → 清除偏好', async () => {
    findUnique.mockResolvedValue(row());
    await svc.update('u1', { provider: null });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { sandboxProvider: null },
    });
  });

  it('改生命周期：落库并应用到当前提供方的现有沙箱', async () => {
    findUnique.mockResolvedValue(
      row({ sandboxIdleMinutes: 15, sandboxAutoDeleteMinutes: 60 }),
    );
    const listing = { id: 'sb-1', state: 'stopped' };
    mockPickUserSandbox.mockResolvedValue(listing);
    await svc.update('u1', { idleMinutes: 15, autoDeleteMinutes: 60 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { sandboxIdleMinutes: 15, sandboxAutoDeleteMinutes: 60 },
    });
    expect(mockPickUserSandbox).toHaveBeenCalledWith('u1', 'daytona');
    expect(applyLifecycle).toHaveBeenCalledWith(listing, {
      idleMinutes: 15,
      autoDeleteMinutes: 60,
    });
  });

  it('应用到沙箱失败 → 保存仍成功（只记日志）', async () => {
    findUnique.mockResolvedValue(row({ sandboxIdleMinutes: 20 }));
    mockPickUserSandbox.mockRejectedValue(new Error('network'));
    await expect(svc.update('u1', { idleMinutes: 20 })).resolves.toMatchObject({
      lifecycle: { idleMinutes: 20 },
    });
  });

  it('无现有沙箱 → 不调用 applyLifecycle', async () => {
    findUnique.mockResolvedValue(row({ sandboxIdleMinutes: 20 }));
    mockPickUserSandbox.mockResolvedValue(null);
    await svc.update('u1', { idleMinutes: 20 });
    expect(applyLifecycle).not.toHaveBeenCalled();
  });

  it('选未配置的提供方 → SANDBOX_PROVIDER_NOT_CONFIGURED，不落库', async () => {
    configured.e2b = false;
    await expect(svc.update('u1', { provider: 'e2b' })).rejects.toMatchObject({
      errCode: ErrorCodes.SANDBOX_PROVIDER_NOT_CONFIGURED.code,
    });
    expect(update).not.toHaveBeenCalled();
  });
  describe('网络设置', () => {
    it('读取：白名单与模式生效；脏值（非法模式 / 非字符串项）按默认或过滤', async () => {
      findUnique.mockResolvedValue(
        row({
          sandboxNetworkMode: 'allowlist',
          sandboxNetworkAllowList: ['pypi.org', 42, '1.1.1.1'],
          sandboxPublicTraffic: true,
        }),
      );
      expect((await svc.resolve('u1')).network).toEqual({
        egress: 'allowlist',
        allowList: ['pypi.org', '1.1.1.1'],
        publicTraffic: true,
      });
      findUnique.mockResolvedValue(row({ sandboxNetworkMode: 'weird' }));
      expect((await svc.resolve('u1')).network.egress).toBe('open');
    });

    it('改出站：归一化落库；运行中且指纹不一致 → 立即应用（applied）', async () => {
      findUnique.mockResolvedValue(
        row({
          sandboxNetworkMode: 'allowlist',
          sandboxNetworkAllowList: ['pypi.org'],
        }),
      );
      const listing = { id: 'sb', state: 'started', egress: 'open' };
      mockPickUserSandbox.mockResolvedValue(listing);
      const s = await svc.update('u1', {
        egressMode: 'allowlist',
        allowList: [' PyPI.org '],
      });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          sandboxNetworkMode: 'allowlist',
          sandboxNetworkAllowList: ['pypi.org'],
        },
      });
      expect(applyEgress).toHaveBeenCalledWith(listing, {
        egress: 'allowlist',
        allowList: ['pypi.org'],
        publicTraffic: false,
      });
      expect(s.egressSync).toBe('applied');
    });

    it('沙箱停机/暂停中 → 不唤醒（pending）；指纹已一致 → applied 且不发请求', async () => {
      findUnique.mockResolvedValue(row({ sandboxNetworkMode: 'blocked' }));
      mockPickUserSandbox.mockResolvedValue({
        id: 'sb',
        state: 'stopped',
        egress: 'open',
      });
      expect(
        (await svc.update('u1', { egressMode: 'blocked' })).egressSync,
      ).toBe('pending');
      mockPickUserSandbox.mockResolvedValue({
        id: 'sb',
        state: 'started',
        egress: 'blocked',
      });
      expect(
        (await svc.update('u1', { egressMode: 'blocked' })).egressSync,
      ).toBe('applied');
      expect(applyEgress).not.toHaveBeenCalled();
    });

    it('应用失败 → failed（保存本身成功）', async () => {
      findUnique.mockResolvedValue(row({ sandboxNetworkMode: 'blocked' }));
      mockPickUserSandbox.mockResolvedValue({
        id: 'sb',
        state: 'started',
        egress: 'open',
      });
      applyEgress.mockRejectedValueOnce(new Error('denied'));
      const s = await svc.update('u1', { egressMode: 'blocked' });
      expect(update).toHaveBeenCalled();
      expect(s.egressSync).toBe('failed');
    });

    it('只改入站开关：只落库，不触发出站同步', async () => {
      findUnique.mockResolvedValue(row({ sandboxPublicTraffic: true }));
      const s = await svc.update('u1', { publicTraffic: true });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { sandboxPublicTraffic: true },
      });
      expect(s.egressSync).toBeUndefined();
      expect(applyEgress).not.toHaveBeenCalled();
    });
  });

  it('currentPublicTraffic：有沙箱时查询实际值；查询失败按未知', async () => {
    findUnique.mockResolvedValue(row({ sandboxProvider: 'e2b' }));
    mockPickUserSandbox.mockResolvedValue({ id: 'sb', state: 'paused' });
    inspectPublicTraffic.mockResolvedValueOnce(true);
    expect((await svc.getSettings('u1')).currentPublicTraffic).toBe(true);
    expect(inspectPublicTraffic).toHaveBeenCalledWith({
      id: 'sb',
      state: 'paused',
    });
    inspectPublicTraffic.mockRejectedValueOnce(new Error('boom'));
    expect((await svc.getSettings('u1')).currentPublicTraffic).toBeNull();
  });

  it('提供方不允许沙箱级出站策略（Daytona Tier 1/2）→ 回滚本次改动 + SANDBOX_NETWORK_UNSUPPORTED', async () => {
    findUnique
      .mockResolvedValueOnce(
        row({ sandboxProvider: 'daytona', sandboxNetworkMode: 'open' }),
      ) // before
      .mockResolvedValue(
        row({ sandboxProvider: 'daytona', sandboxNetworkMode: 'blocked' }),
      );
    mockPickUserSandbox.mockResolvedValue({
      id: 'sb',
      state: 'started',
      egress: 'open',
    });
    applyEgress.mockRejectedValueOnce(
      new SandboxNetworkUnsupportedError(
        'cannot be overridden at the sandbox level',
      ),
    );
    await expect(
      svc.update('u1', { egressMode: 'blocked' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.SANDBOX_NETWORK_UNSUPPORTED.code,
    });
    expect(update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: { sandboxNetworkMode: 'open' },
    });
  });

  describe('提供方不支持沙箱级出站策略（Daytona Tier 1/2）', () => {
    beforeEach(() => {
      egressControl.daytona = false;
    });

    it('resolve：存着「禁止」也按 open 生效（不下发、不让整轮降级），白名单原样保留给 E2B', async () => {
      findUnique.mockResolvedValue(
        row({
          sandboxProvider: 'daytona',
          sandboxNetworkMode: 'blocked',
          sandboxNetworkAllowList: ['pypi.org'],
        }),
      );
      expect((await svc.resolve('u1')).network).toEqual({
        egress: 'open',
        allowList: ['pypi.org'],
        publicTraffic: false,
      });
      // 设置页仍展示用户存的偏好（切回 E2B 时生效）
      expect((await svc.getSettings('u1')).network.egress).toBe('blocked');
    });

    it('在 Daytona 上设置出站限制 → 提前 40010，不落库', async () => {
      findUnique.mockResolvedValue(row({ sandboxProvider: 'daytona' }));
      await expect(
        svc.update('u1', { egressMode: 'allowlist' }),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.SANDBOX_NETWORK_UNSUPPORTED.code,
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('存着「禁止」时切到 Daytona：允许切换，且不下发出站规则、无同步状态', async () => {
      findUnique.mockResolvedValue(
        row({ sandboxProvider: 'daytona', sandboxNetworkMode: 'blocked' }),
      );
      const s = await svc.update('u1', { provider: 'daytona' });
      expect(s.current).toBe('daytona');
      expect(s.egressSync).toBeUndefined();
      expect(applyEgress).not.toHaveBeenCalled();
    });
  });
});
