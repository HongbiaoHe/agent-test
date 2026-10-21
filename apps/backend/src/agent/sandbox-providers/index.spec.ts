/**
 * 提供方选择（SANDBOX_PROVIDER）与 E2B listing 映射单测。
 * 两个提供方模块的 SDK 均为深 ESM 链，mock 掉 SDK 只测选择与映射逻辑。
 */
jest.mock('@daytonaio/sdk', () => ({ Daytona: jest.fn() }));
jest.mock('@langchain/daytona', () => ({ DaytonaSandbox: class {} }));
jest.mock('e2b', () => ({ Sandbox: {} }));
jest.mock('./e2b-sandbox', () => ({ E2BSandbox: class {} }));

import type { SandboxInfo } from 'e2b';
import { getSandboxProvider } from './index';
import { e2bTemplate, toListing } from './e2b.provider';

describe('getSandboxProvider', () => {
  const ORIG = process.env.SANDBOX_PROVIDER;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = ORIG;
  });

  it('未配置 → daytona（保持历史行为）', () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(getSandboxProvider().name).toBe('daytona');
  });

  it('e2b（大小写/空白不敏感）', () => {
    process.env.SANDBOX_PROVIDER = ' E2B ';
    expect(getSandboxProvider().name).toBe('e2b');
  });

  it('daytona', () => {
    process.env.SANDBOX_PROVIDER = 'daytona';
    expect(getSandboxProvider().name).toBe('daytona');
  });

  it('非法值 → 抛错（不静默回退）', () => {
    process.env.SANDBOX_PROVIDER = 'docker';
    expect(() => getSandboxProvider()).toThrow('SANDBOX_PROVIDER 配置非法');
  });

  it('网络能力：e2b 支持域名白名单与入站开关，daytona 都不支持', () => {
    expect(getSandboxProvider('e2b').supportsDomainAllowList).toBe(true);
    expect(getSandboxProvider('e2b').supportsPublicTrafficToggle).toBe(true);
    expect(getSandboxProvider('daytona').supportsDomainAllowList).toBe(false);
    expect(getSandboxProvider('daytona').supportsPublicTrafficToggle).toBe(
      false,
    );
  });

  it('能力：daytona 支持桌面与停机后删除，e2b 都不支持', () => {
    expect(getSandboxProvider('daytona').desktop).toBeDefined();
    expect(getSandboxProvider('daytona').supportsAutoDelete).toBe(true);
    expect(getSandboxProvider('e2b').desktop).toBeUndefined();
    expect(getSandboxProvider('e2b').supportsAutoDelete).toBe(false);
  });

  it('显式传入提供方优先于 env', () => {
    process.env.SANDBOX_PROVIDER = 'daytona';
    expect(getSandboxProvider('e2b').name).toBe('e2b');
  });

  it('isConfigured 按各自 API key 判断', () => {
    const d = process.env.DAYTONA_API_KEY;
    const e = process.env.E2B_API_KEY;
    process.env.SANDBOX_PROVIDER = 'e2b';
    delete process.env.E2B_API_KEY;
    process.env.DAYTONA_API_KEY = 'x';
    expect(getSandboxProvider().isConfigured()).toBe(false);
    process.env.E2B_API_KEY = 'y';
    expect(getSandboxProvider().isConfigured()).toBe(true);
    if (d === undefined) delete process.env.DAYTONA_API_KEY;
    else process.env.DAYTONA_API_KEY = d;
    if (e === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = e;
  });
});

describe('E2B toListing', () => {
  const info = (state: 'running' | 'paused'): SandboxInfo => ({
    sandboxId: 'sb',
    templateId: 't',
    metadata: { user_id: 'u1' },
    startedAt: new Date('2026-10-14T03:00:00Z'),
    endAt: new Date('2026-10-14T03:05:00Z'),
    state,
    cpuCount: 2,
    memoryMB: 512,
    envdVersion: '0.1',
  });

  it('running → started；带规格（cpu/内存）；不带网络字段（list 结果不含网络信息，缺省 = 未知）', () => {
    expect(toListing(info('running'))).toEqual({
      id: 'sb',
      state: 'started',
      createdAt: '2026-10-14T03:00:00.000Z',
      cpuCount: 2,
      memoryMB: 512,
    });
  });

  it('paused → stopped', () => {
    expect(toListing(info('paused')).state).toBe('stopped');
  });
});

describe('e2bTemplate（新建沙箱用的模板）', () => {
  const ORIG = process.env.E2B_TEMPLATE;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.E2B_TEMPLATE;
    else process.env.E2B_TEMPLATE = ORIG;
  });

  it('未设置 / 空白 → base（E2B 默认 2 vCPU / 512 MB）', () => {
    delete process.env.E2B_TEMPLATE;
    expect(e2bTemplate()).toBe('base');
    process.env.E2B_TEMPLATE = '  ';
    expect(e2bTemplate()).toBe('base');
  });

  it('设置了 → 用它（去首尾空白）', () => {
    process.env.E2B_TEMPLATE = ' spark-2c2g ';
    expect(e2bTemplate()).toBe('spark-2c2g');
  });
});
