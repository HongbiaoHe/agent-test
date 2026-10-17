/**
 * pickPreferredSandbox 单测：多沙箱（历史裂变残留）下的确定性选择规则。
 * started 优先 > stopped > 过渡/异常态；同级取 createdAt 最早。
 *
 * sandbox.ts 模块级引入 sandbox-providers（其下 Daytona / E2B SDK 为深 ESM 链，jest 加载失败），
 * 被测函数不触及提供方，mock 掉即可。
 */
jest.mock('./sandbox-providers', () => ({
  getSandboxProvider: jest.fn(),
  DEFAULT_SANDBOX_LIFECYCLE: { idleMinutes: 5, autoDeleteMinutes: 10 },
  DEFAULT_SANDBOX_NETWORK: {
    egress: 'open',
    allowList: [],
    publicTraffic: false,
  },
}));

import {
  findUserSandbox,
  getUserSandbox,
  listDir,
  listWorkspaceFiles,
  pickPreferredSandbox,
  keepUserSandboxAlive,
  startUserDesktop,
  stopUserDesktop,
  readFilePreview,
  uploadSkillsToSandbox,
  type SandboxListing,
} from './sandbox';
import { GuardedSandbox } from './guarded-sandbox';
import type { GuardableSandbox } from './sandbox-providers';
import type { SkillDef } from '../skills/skills.service';
import { getSandboxProvider } from './sandbox-providers';

const sb = (id: string, state: string, createdAt: string): SandboxListing => ({
  id,
  state,
  createdAt,
});

describe('pickPreferredSandbox', () => {
  it('空列表 → null', () => {
    expect(pickPreferredSandbox([])).toBeNull();
  });

  it('单个直接返回', () => {
    const a = sb('a', 'stopped', '2026-06-11T01:00:00Z');
    expect(pickPreferredSandbox([a])).toBe(a);
  });

  it('started 优先于 stopped，即使 stopped 创建更早', () => {
    const old = sb('old', 'stopped', '2026-06-11T01:00:00Z');
    const run = sb('run', 'started', '2026-06-11T02:00:00Z');
    expect(pickPreferredSandbox([old, run])!.id).toBe('run');
  });

  it('同为 started 取 createdAt 最早（最可能持有历史文件）', () => {
    const a = sb('a', 'started', '2026-06-11T02:00:00Z');
    const b = sb('b', 'started', '2026-06-11T01:00:00Z');
    expect(pickPreferredSandbox([a, b])!.id).toBe('b');
  });

  it('stopped 优先于 stopping/其他过渡态', () => {
    const stopping = sb('x', 'stopping', '2026-06-11T01:00:00Z');
    const stopped = sb('y', 'stopped', '2026-06-11T02:00:00Z');
    expect(pickPreferredSandbox([stopping, stopped])!.id).toBe('y');
  });

  it('不改变入参顺序（纯函数）', () => {
    const a = sb('a', 'stopped', '2026-06-11T02:00:00Z');
    const b = sb('b', 'started', '2026-06-11T01:00:00Z');
    const input = [a, b];
    pickPreferredSandbox(input);
    expect(input[0]).toBe(a);
  });
});

/**
 * 文件面板的两个列举函数：用**真的** GuardedSandbox 包一个只模拟提供方的 inner——inner 返回
 * 真实路径，经出站改写成 /workspace/... 后再被归一。以前这里直接 mock 出 `/src/` 这种旧格式，
 * 把旧约定写死在测试里，于是工作区路径改成 /workspace 后「根目录列得出、展开全是空」没被拦住。
 */
const WS = '/home/user/agent-workspace';
function guardedWith(inner: {
  ls?: jest.Mock;
  execute?: jest.Mock;
}): GuardedSandbox {
  return new GuardedSandbox(
    inner as unknown as GuardableSandbox,
    WS,
    '/workspace',
  );
}

describe('listDir', () => {
  it('过滤 node_modules / 隐藏 / skills，目录优先按名排序；path 是工作区相对路径', async () => {
    const ls = jest.fn().mockResolvedValue({
      files: [
        { path: `${WS}/src/`, is_dir: true },
        { path: `${WS}/README.md`, size: 12 },
        { path: `${WS}/node_modules/`, is_dir: true },
        { path: `${WS}/.git/`, is_dir: true },
        { path: `${WS}/skills/`, is_dir: true },
        { path: `${WS}/app/`, is_dir: true },
      ],
    });
    const out = await listDir(guardedWith({ ls }), '');
    expect(ls).toHaveBeenCalledWith(WS);
    expect(out.map((e) => e.name)).toEqual(['app', 'src', 'README.md']);
    expect(out[0]).toMatchObject({ name: 'app', path: 'app', isDir: true });
  });

  it('根目录列出的 path 原样传回去展开 → 命中正确的子目录（回归：曾展开为空）', async () => {
    const ls = jest
      .fn()
      .mockResolvedValueOnce({
        files: [{ path: `${WS}/todo-vite/`, is_dir: true }],
      })
      .mockResolvedValueOnce({
        files: [
          { path: `${WS}/todo-vite/src/`, is_dir: true },
          { path: `${WS}/todo-vite/index.html`, size: 3 },
        ],
      });
    const sb = guardedWith({ ls });
    const [root] = await listDir(sb, '');
    expect(root.path).toBe('todo-vite');
    const children = await listDir(sb, root.path);
    expect(ls).toHaveBeenLastCalledWith(`${WS}/todo-vite`);
    expect(children).toEqual([
      { name: 'src', path: 'todo-vite/src', isDir: true, size: 0 },
      {
        name: 'index.html',
        path: 'todo-vite/index.html',
        isDir: false,
        size: 3,
      },
    ]);
  });
});

describe('listWorkspaceFiles', () => {
  it('find 输出（真实路径）→ 工作区相对路径', async () => {
    const execute = jest.fn().mockResolvedValue({
      output: `${WS}/todo-vite/index.html\n${WS}/notes.md\n\n`,
      exitCode: 0,
      truncated: false,
    });
    expect(await listWorkspaceFiles(guardedWith({ execute }))).toEqual([
      { path: 'todo-vite/index.html' },
      { path: 'notes.md' },
    ]);
  });
});

describe('readFilePreview', () => {
  it('文本扩展走 read()，原样返回（带行号），未截断', async () => {
    const sbm = {
      read: jest
        .fn()
        .mockResolvedValue({ content: '     1\thello\n     2\tworld' }),
      readRaw: jest.fn(),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'a/b.ts');
    expect(out).toEqual({
      kind: 'text',
      content: '     1\thello\n     2\tworld',
      truncated: false,
    });
    expect((sbm.readRaw as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('图片扩展走 readRaw() → base64 dataUrl，不走 read()', async () => {
    const sbm = {
      read: jest.fn(),
      readRaw: jest.fn().mockResolvedValue({
        data: { content: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      }),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'pics/x.png');
    expect(out).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    });
    expect((sbm.read as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('其余扩展返回 binary 占位（带字节数）', async () => {
    const sbm = {
      read: jest.fn(),
      readRaw: jest.fn().mockResolvedValue({
        data: {
          content: new Uint8Array([0, 0, 0, 0]),
          mimeType: 'application/zip',
        },
      }),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'dist/app.zip');
    expect(out).toEqual({ kind: 'binary', size: 4 });
  });
});

describe('uploadSkillsToSandbox 去重', () => {
  const def: SkillDef = {
    name: 'tvc-director',
    description: '',
    kind: 'builtin',
    source: 'builtin',
    enabled: true,
    files: { 'SKILL.md': '# tvc' },
  };

  // mock GuardedSandbox：downloadFiles 返回给定 .manifest，uploadFiles 记录上传项
  const mkSb = (manifest: {
    content: Uint8Array | null;
    error: string | null;
  }) => {
    const uploaded: Array<[string, Uint8Array]> = [];
    const sbm = {
      skillsDir: '/workspace/skills',
      downloadFiles: jest
        .fn()
        .mockResolvedValue([
          { path: '/workspace/skills/.manifest', ...manifest },
        ]),
      execute: jest.fn().mockResolvedValue({ output: '', exitCode: 0 }),
      uploadFiles: jest.fn(async (files: Array<[string, Uint8Array]>) => {
        uploaded.push(...files);
        return files.map(([p]) => ({ path: p, error: null }));
      }),
    } as unknown as GuardedSandbox;
    return { sbm, uploaded };
  };

  it('无 manifest（首次/新沙箱）→ 先清空旧目录再全量上传 + 写 .manifest', async () => {
    const { sbm, uploaded } = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(sbm, [def]);
    expect(sbm.execute).toHaveBeenCalledWith('rm -rf skills');
    const paths = uploaded.map(([p]) => p);
    // 技能库在工作区下（/workspace/skills），这条路径在 shell 里同样可用
    expect(paths).toContain('/workspace/skills/tvc-director/SKILL.md');
    expect(paths).toContain('/workspace/skills/.manifest');
  });

  it('SKILL.md 的相对引用改写到工作区技能库（read_file 与 execute 都能命中）', async () => {
    const { sbm, uploaded } = mkSb({ content: null, error: 'file_not_found' });
    const withRef: SkillDef = {
      ...def,
      files: { 'SKILL.md': '先读 `./references/a.md`' },
    };
    await uploadSkillsToSandbox(sbm, [withRef]);
    const md = uploaded.find(([p]) => p.endsWith('/SKILL.md'))![1];
    expect(new TextDecoder().decode(md)).toBe(
      '先读 `/workspace/skills/tvc-director/references/a.md`',
    );
  });

  it('manifest 指纹一致 → 跳过：不 execute、不 uploadFiles', async () => {
    // 先跑一次拿到写入沙箱的指纹（避免硬编码 sha256）
    const first = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(first.sbm, [def]);
    const fingerprint = first.uploaded.find(
      ([p]) => p === '/workspace/skills/.manifest',
    )![1];

    // 第二次：downloadFiles 回灌相同指纹 → 应整体跳过
    const second = mkSb({ content: fingerprint, error: null });
    await uploadSkillsToSandbox(second.sbm, [def]);
    expect(second.sbm.execute).not.toHaveBeenCalled();
    expect(second.sbm.uploadFiles).not.toHaveBeenCalled();
  });

  it('技能内容变化 → 指纹不符 → 重新清空并上传', async () => {
    const first = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(first.sbm, [def]);
    const fingerprint = first.uploaded.find(
      ([p]) => p === '/workspace/skills/.manifest',
    )![1];

    const changed: SkillDef = { ...def, files: { 'SKILL.md': '# tvc v2' } };
    const second = mkSb({ content: fingerprint, error: null });
    await uploadSkillsToSandbox(second.sbm, [changed]);
    expect(second.sbm.execute).toHaveBeenCalledWith('rm -rf skills');
    expect(second.sbm.uploadFiles).toHaveBeenCalled();
  });
});

describe('提供方编排（getUserSandbox / findUserSandbox / desktop）', () => {
  const mockGetProvider = getSandboxProvider as jest.Mock;

  /** 构造一个 provider mock；inner.execute 记录 mkdir 工作区命令。 */
  function makeProvider(opts: {
    configured?: boolean;
    listings?: Array<{
      id: string;
      state: string;
      createdAt?: string;
      egress?: string;
    }>;
    desktop?: boolean;
  }) {
    const inner = {
      id: 'inner',
      execute: jest
        .fn()
        .mockResolvedValue({ output: '', exitCode: 0, truncated: false }),
    };
    const conn = { inner, homeDir: '/home/user' };
    const provider = {
      name: 'e2b',
      isConfigured: () => opts.configured ?? true,
      listUserSandboxes: jest.fn().mockResolvedValue(opts.listings ?? []),
      connect: jest.fn().mockResolvedValue(conn),
      create: jest.fn().mockResolvedValue(conn),
      // 指纹口径简化：open → 'open'，blocked → 'blocked'
      desiredEgress: jest.fn((n: { egress: string }) => n.egress),
      applyEgress: jest.fn().mockResolvedValue(undefined),
      keepAlive: jest.fn().mockResolvedValue(undefined),
      desktop: opts.desktop
        ? {
            start: jest.fn().mockResolvedValue('https://vnc'),
            stop: jest.fn().mockResolvedValue(undefined),
          }
        : undefined,
    };
    mockGetProvider.mockReturnValue(provider);
    return { provider, inner };
  }

  it('凭据未配置 → getUserSandbox/findUserSandbox 返回 null，不 list', async () => {
    const { provider } = makeProvider({ configured: false });
    expect(await getUserSandbox('u1')).toBeNull();
    expect(await findUserSandbox('u1')).toBeNull();
    expect(provider.listUserSandboxes).not.toHaveBeenCalled();
  });

  it('无已有沙箱 → create，并在 home 下建工作区、返回守卫 wrapper', async () => {
    const { provider, inner } = makeProvider({});
    const sb = await getUserSandbox('u1');
    // 不传 config → 默认生命周期（闲置 5 分钟 / 停机 10 分钟删除）
    expect(provider.create).toHaveBeenCalledWith(
      'u1',
      { idleMinutes: 5, autoDeleteMinutes: 10 },
      { egress: 'open', allowList: [], publicTraffic: false },
    );
    expect(provider.connect).not.toHaveBeenCalled();
    const setup = String(inner.execute.mock.calls[0][0]);
    expect(setup).toMatch(/^mkdir -p '\/home\/user\/agent-workspace' && /);
    expect(setup).toContain("ln -s '/home/user/agent-workspace' /workspace");
    expect(sb?.workspaceRoot).toBe('/home/user/agent-workspace');
  });

  it('/workspace 软链就绪 → agent 看到的工作区是 /workspace', async () => {
    const { inner } = makeProvider({});
    inner.execute.mockResolvedValueOnce({
      output: 'WORKSPACE_LINK_OK\n',
      exitCode: 0,
      truncated: false,
    });
    const sb = await getUserSandbox('u1');
    expect(sb?.visibleRoot).toBe('/workspace');
    expect(sb?.skillsDir).toBe('/workspace/skills');
  });

  it('建不了软链（无 sudo / /workspace 被占用）→ 退回真实路径，两边依然一致', async () => {
    // inner.execute 缺省输出为空（没有 WORKSPACE_LINK_OK）
    makeProvider({});
    const sb = await getUserSandbox('u1');
    expect(sb?.visibleRoot).toBe('/home/user/agent-workspace');
    expect(sb?.skillsDir).toBe('/home/user/agent-workspace/skills');
  });

  it('建工作区 mkdir 偶发网络失败 → 重试一次后成功', async () => {
    const { inner } = makeProvider({});
    inner.execute.mockRejectedValueOnce(new Error('fetch failed'));
    const sb = await getUserSandbox('u1');
    expect(inner.execute).toHaveBeenCalledTimes(2);
    expect(sb?.workspaceRoot).toBe('/home/user/agent-workspace');
  });

  it('有已有沙箱 → connect 确定性选中的那个（started 优先），不 create', async () => {
    const { provider } = makeProvider({
      listings: [
        { id: 'old-stopped', state: 'stopped', createdAt: '1' },
        { id: 'run', state: 'started', createdAt: '2' },
      ],
    });
    await getUserSandbox('u1');
    expect(provider.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run' }),
      { idleMinutes: 5, autoDeleteMinutes: 10 },
    );
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('传入用户配置 → 按其提供方取沙箱、生命周期与网络透传给 create', async () => {
    const { provider } = makeProvider({});
    const lifecycle = { idleMinutes: 30, autoDeleteMinutes: -1 };
    const network = {
      egress: 'blocked' as const,
      allowList: [],
      publicTraffic: false,
    };
    await getUserSandbox('u1', { provider: 'e2b', lifecycle, network });
    expect(mockGetProvider).toHaveBeenCalledWith('e2b');
    expect(provider.create).toHaveBeenCalledWith('u1', lifecycle, network);
  });

  describe('出站规则同步（已有沙箱）', () => {
    const lifecycle = { idleMinutes: 5, autoDeleteMinutes: 10 };
    const blocked = {
      egress: 'blocked' as const,
      allowList: [],
      publicTraffic: false,
    };

    it('远端指纹与设置一致 → 不发更新请求', async () => {
      const { provider } = makeProvider({
        listings: [{ id: 'a', state: 'started', egress: 'blocked' }],
      });
      await getUserSandbox('u1', {
        provider: 'e2b',
        lifecycle,
        network: blocked,
      });
      expect(provider.applyEgress).not.toHaveBeenCalled();
    });

    it('不一致（如暂停期间改了设置）→ 连接后先同步再返回', async () => {
      const { provider } = makeProvider({
        listings: [{ id: 'a', state: 'stopped', egress: 'open' }],
      });
      const sb = await getUserSandbox('u1', {
        provider: 'e2b',
        lifecycle,
        network: blocked,
      });
      expect(provider.applyEgress).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a', state: 'started' }),
        blocked,
      );
      expect(sb).not.toBeNull();
    });

    it('同步失败 → 向上抛（宁可本轮无沙箱也不在错误放行状态下跑）', async () => {
      const { provider } = makeProvider({
        listings: [{ id: 'a', state: 'started', egress: 'open' }],
      });
      provider.applyEgress.mockRejectedValue(new Error('tier not allowed'));
      await expect(
        getUserSandbox('u1', { provider: 'e2b', lifecycle, network: blocked }),
      ).rejects.toThrow('tier not allowed');
    });
  });

  it('connect 失败 → getUserSandbox 向上抛（不裂变新沙箱）', async () => {
    const { provider } = makeProvider({
      listings: [{ id: 'a', state: 'stopped' }],
    });
    provider.connect.mockRejectedValue(new Error('resume failed'));
    await expect(getUserSandbox('u1')).rejects.toThrow('resume failed');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('findUserSandbox：无沙箱 → null 且不 create；connect 失败 → null', async () => {
    const { provider } = makeProvider({});
    expect(await findUserSandbox('u1')).toBeNull();
    expect(provider.create).not.toHaveBeenCalled();

    makeProvider({
      listings: [{ id: 'a', state: 'stopped' }],
    }).provider.connect.mockRejectedValue(new Error('x'));
    expect(await findUserSandbox('u1')).toBeNull();
  });

  it('提供方不支持桌面（E2B）→ startUserDesktop 返回 null、stop 静默', async () => {
    const { provider } = makeProvider({
      listings: [{ id: 'a', state: 'started' }],
    });
    expect(await startUserDesktop('u1')).toBeNull();
    await expect(stopUserDesktop('u1')).resolves.toBeUndefined();
    expect(provider.listUserSandboxes).not.toHaveBeenCalled();
  });

  it('支持桌面且运行中 → 委托 provider.desktop.start；停机 → null', async () => {
    const { provider } = makeProvider({
      listings: [{ id: 'a', state: 'started' }],
      desktop: true,
    });
    expect(await startUserDesktop('u1')).toBe('https://vnc');
    expect(provider.desktop?.start).toHaveBeenCalledWith('a');

    makeProvider({ listings: [{ id: 'a', state: 'stopped' }], desktop: true });
    expect(await startUserDesktop('u1')).toBeNull();
  });

  it('keepUserSandboxAlive：运行中的沙箱按用户设置续期；没有 / 停机的沙箱不碰（预览不负责拉起）', async () => {
    const lifecycle = { idleMinutes: 15, autoDeleteMinutes: 10 };
    const network = { egress: 'open', allowList: [], publicTraffic: false };
    const running = makeProvider({
      listings: [{ id: 'sb-1', state: 'started' }],
    });
    await keepUserSandboxAlive('u1', {
      provider: 'e2b',
      lifecycle,
      network,
    } as never);
    expect(running.provider.keepAlive).toHaveBeenCalledWith('sb-1', lifecycle);

    const stopped = makeProvider({
      listings: [{ id: 'sb-2', state: 'stopped' }],
    });
    await keepUserSandboxAlive('u1');
    expect(stopped.provider.keepAlive).not.toHaveBeenCalled();
  });
});
