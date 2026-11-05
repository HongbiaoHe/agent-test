/**
 * GuardedSandbox 单测（统一工作区路径语义，见 guarded-sandbox.ts 文件头）
 *
 * inner 用手写 mock（不依赖 deepagents 运行时）。
 * 规则（visibleRoot = /workspace，即沙箱里指向真实工作区的软链）：
 *  - 入站：`/workspace/foo` 与相对 `foo` → ws/foo；`/` 与 '' → ws（文件工具缺省值）；真实 ws 路径原样接受
 *  - 工作区外的绝对路径（含旧约定的 `/foo`）与 `../` 逃逸 → error 形状、inner 未被调用、
 *    消息给出正确写法且不含真实路径
 *  - 出站：结果里的真实 ws 前缀改写为 /workspace（含 execute 输出）；readRaw.data 不动
 *  - execute → inner 收到 `cd '/workspace' && ( 原命令 )`——shell 与文件工具看到同一条路径
 *  - 软链建不了时 visibleRoot = 真实路径：两边同样一致
 *  - 技能库 /workspace/skills 只读；uploadFiles / downloadFiles 走同一映射
 */

// GuardedSandbox 不依赖 deepagents 运行时，无需 jest.mock
import { GuardedSandbox } from './guarded-sandbox';

const WS = '/home/user/agent-workspace';
const VIS = '/workspace';

/** 构建一个全方法 jest.fn() 的 inner mock */
function makeMockInner() {
  return {
    id: 'mock-sandbox-id',
    isRunning: true,
    execute: jest
      .fn()
      .mockResolvedValue({ output: '', exitCode: 0, truncated: false }),
    ls: jest.fn().mockResolvedValue({ files: [] }),
    read: jest.fn().mockResolvedValue({ content: 'hello' }),
    readRaw: jest.fn().mockResolvedValue({ data: {} }),
    write: jest.fn().mockResolvedValue({ path: '/path' }),
    edit: jest.fn().mockResolvedValue({ path: '/path', occurrences: 1 }),
    glob: jest.fn().mockResolvedValue({ files: [] }),
    grep: jest.fn().mockResolvedValue({ matches: [] }),
    uploadFiles: jest.fn().mockResolvedValue([]),
    downloadFiles: jest.fn().mockResolvedValue([]),
    getWorkDir: jest.fn().mockResolvedValue(WS),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

/** linked=false 模拟软链建不了：不传 visibleRoot，走构造函数的缺省（真实路径）。 */
function setup({ linked = true } = {}) {
  const inner = makeMockInner();
  const guard = linked
    ? new GuardedSandbox(inner, WS, VIS)
    : new GuardedSandbox(inner, WS);
  return { inner, guard };
}

describe('GuardedSandbox — 入站路径映射', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    ({ inner, guard } = setup());
  });

  it("ls('/') 与 ls('') → 工作区根（文件工具的缺省值）", async () => {
    await guard.ls('/');
    await guard.ls('');
    expect(inner.ls).toHaveBeenNthCalledWith(1, WS);
    expect(inner.ls).toHaveBeenNthCalledWith(2, WS);
  });

  it("ls('/workspace') / ls('/workspace/sub') → ws / ws/sub", async () => {
    await guard.ls('/workspace');
    await guard.ls('/workspace/sub');
    expect(inner.ls).toHaveBeenNthCalledWith(1, WS);
    expect(inner.ls).toHaveBeenNthCalledWith(2, `${WS}/sub`);
  });

  it("ls('sub') 相对路径 → ws/sub（与 execute 的 cwd 一致）", async () => {
    await guard.ls('sub');
    expect(inner.ls).toHaveBeenCalledWith(`${WS}/sub`);
  });

  it('真实工作区路径原样接受（宿主侧 / pwd -P）', async () => {
    await guard.ls(`${WS}/sub`);
    expect(inner.ls).toHaveBeenCalledWith(`${WS}/sub`);
  });

  it('工作区外的绝对路径（含旧约定 /foo）→ error，提示正确写法，不含真实路径', async () => {
    for (const p of ['/etc/passwd', '/vite-counter/index.html']) {
      const res = await guard.read(p);
      expect(res.error).toContain(`文件工具只能访问 ${VIS} 下的路径`);
      expect(res.error).not.toContain(WS);
    }
    expect(inner.read).not.toHaveBeenCalled();
  });

  it("前缀相似但不在工作区内（'/workspacex'）→ error", async () => {
    const res = await guard.ls('/workspacex');
    expect(res.error).toBeDefined();
    expect(inner.ls).not.toHaveBeenCalled();
  });

  it('../ 逃逸（相对 / 绝对写法）→ error，inner 未被调用', async () => {
    expect((await guard.ls('../..')).error).toBeDefined();
    expect((await guard.ls('/workspace/a/../../etc')).error).toBeDefined();
    expect((await guard.read('../secret.txt')).error).toBeDefined();
    expect(inner.ls).not.toHaveBeenCalled();
    expect(inner.read).not.toHaveBeenCalled();
  });

  it('read: 路径映射 + offset/limit 透传', async () => {
    await guard.read('/workspace/doc.md', 10, 50);
    expect(inner.read).toHaveBeenCalledWith(`${WS}/doc.md`, 10, 50);
  });

  it('write: 路径映射 + 内容透传；逃逸 → error', async () => {
    await guard.write('/workspace/out/a.txt', 'hi');
    expect(inner.write).toHaveBeenCalledWith(`${WS}/out/a.txt`, 'hi');
    expect((await guard.write('../../x', 'hi')).error).toBeDefined();
    expect(inner.write).toHaveBeenCalledTimes(1);
  });

  it('edit: 路径映射 + 参数透传', async () => {
    await guard.edit('/workspace/a.md', 'old', 'new', true);
    expect(inner.edit).toHaveBeenCalledWith(`${WS}/a.md`, 'old', 'new', true);
  });

  it('readRaw: 路径映射', async () => {
    await guard.readRaw('/workspace/img.png');
    expect(inner.readRaw).toHaveBeenCalledWith(`${WS}/img.png`);
  });

  it('glob / grep: 缺省 searchPath → 显式锚定工作区根；给定路径照常映射', async () => {
    await guard.glob('*.md');
    await guard.glob('*.md', '/workspace/src');
    await guard.grep('x', null);
    expect(inner.glob).toHaveBeenNthCalledWith(1, '*.md', WS);
    expect(inner.glob).toHaveBeenNthCalledWith(2, '*.md', `${WS}/src`);
    expect(inner.grep).toHaveBeenCalledWith('x', WS, undefined);
  });

  it('grep: 工作区外 searchPath → error，inner 未被调用', async () => {
    expect((await guard.grep('x', '/etc')).error).toBeDefined();
    expect(inner.grep).not.toHaveBeenCalled();
  });
});

describe('GuardedSandbox — 出站改写（真实路径 → /workspace）', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    ({ inner, guard } = setup());
  });

  it('ls 结果里的真实路径改写为 /workspace', async () => {
    inner.ls.mockResolvedValue({
      files: [
        { path: `${WS}/a.txt`, isDir: false },
        { path: `${WS}/sub`, isDir: true },
      ],
    });
    expect(await guard.ls('/')).toEqual({
      files: [
        { path: '/workspace/a.txt', isDir: false },
        { path: '/workspace/sub', isDir: true },
      ],
    });
  });

  it('write 回显路径、inner 的 error 消息同样改写', async () => {
    inner.write.mockResolvedValue({ path: `${WS}/out.txt` });
    expect(await guard.write('out.txt', 'x')).toEqual({
      path: '/workspace/out.txt',
    });
    inner.read.mockResolvedValue({ error: `file not found: ${WS}/nope.txt` });
    expect(await guard.read('nope.txt')).toEqual({
      error: 'file not found: /workspace/nope.txt',
    });
  });

  it('execute 输出里的真实路径（如 pwd -P）改写为 /workspace', async () => {
    inner.execute.mockResolvedValue({
      output: `${WS}\n${WS}/dist/out.docx\n`,
      exitCode: 0,
      truncated: false,
    });
    const result = await guard.execute('pwd -P && ls dist');
    expect(result.output).toBe('/workspace\n/workspace/dist/out.docx\n');
  });

  it('readRaw 的 data 字段不做字符串替换（二进制/base64 安全）', async () => {
    const data = { base64: `${WS}-looking-string-stays` };
    inner.readRaw.mockResolvedValue({ data });
    const result = (await guard.readRaw('img.png')) as unknown as {
      data: typeof data;
    };
    expect(result.data).toBe(data);
  });
});

describe('GuardedSandbox — execute cwd 锚定', () => {
  it('cd 到 /workspace：shell 里的路径与文件工具一致', async () => {
    const { inner, guard } = setup();
    const cmd = 'python3 /workspace/skills/docx/scripts/run.py --in a.txt';
    await guard.execute(cmd);
    expect(inner.execute).toHaveBeenCalledWith(`cd '/workspace' && ( ${cmd} )`);
  });
});

describe('GuardedSandbox — 软链建不了时退回真实路径', () => {
  it('visibleRoot = 真实路径：cd 真实路径、输出不改写、真实绝对路径可用、其它绝对路径拒绝', async () => {
    const { inner, guard } = setup({ linked: false });
    expect(guard.visibleRoot).toBe(WS);
    expect(guard.skillsDir).toBe(`${WS}/skills`);
    inner.execute.mockResolvedValue({
      output: `${WS}\n`,
      exitCode: 0,
      truncated: false,
    });
    expect((await guard.execute('pwd')).output).toBe(`${WS}\n`);
    expect(inner.execute).toHaveBeenCalledWith(`cd '${WS}' && ( pwd )`);
    await guard.read(`${WS}/a.md`);
    expect(inner.read).toHaveBeenCalledWith(`${WS}/a.md`, undefined, undefined);
    const res = await guard.read('/workspace/a.md');
    expect(res.error).toContain(`文件工具只能访问 ${WS} 下的路径`);
  });
});

describe('GuardedSandbox — toWorkspaceRelative（宿主接口用）', () => {
  it('各种写法 → 工作区相对路径；工作区外 → null', () => {
    const { guard } = setup();
    expect(guard.toWorkspaceRelative('/workspace/app/index.html')).toBe(
      'app/index.html',
    );
    expect(guard.toWorkspaceRelative('app/index.html')).toBe('app/index.html');
    expect(guard.toWorkspaceRelative(`${WS}/app/index.html`)).toBe(
      'app/index.html',
    );
    expect(guard.toWorkspaceRelative('/workspace')).toBe('');
    expect(guard.toWorkspaceRelative('/etc/hosts')).toBeNull();
    expect(guard.toWorkspaceRelative('../x.html')).toBeNull();
  });
});

describe('GuardedSandbox — getWorkDir', () => {
  it('getWorkDir 返回真实 workspaceRoot（仅宿主侧使用）', async () => {
    const { inner, guard } = setup();
    expect(await guard.getWorkDir()).toBe(WS);
    expect(inner.getWorkDir).not.toHaveBeenCalled();
  });
});

describe('GuardedSandbox — uploadFiles / downloadFiles 路径映射', () => {
  const enc = new TextEncoder();

  it('uploadFiles: /workspace/skills/... → ws/skills/... 再交给 inner', async () => {
    const { inner, guard } = setup();
    inner.uploadFiles.mockResolvedValue([
      { path: `${WS}/skills/docx/SKILL.md`, error: null },
    ]);
    await guard.uploadFiles([
      ['/workspace/skills/docx/SKILL.md', enc.encode('# Docx')],
    ]);
    expect(inner.uploadFiles).toHaveBeenCalledWith([
      [`${WS}/skills/docx/SKILL.md`, enc.encode('# Docx')],
    ]);
  });

  it('uploadFiles: 工作区外的路径 → invalid_path、inner 未被调用该项', async () => {
    const { inner, guard } = setup();
    const res = await guard.uploadFiles([['../../etc/evil', enc.encode('x')]]);
    expect(res[0].error).toBe('invalid_path');
    expect(inner.uploadFiles).not.toHaveBeenCalled();
  });

  it('downloadFiles: 映射进 ws；返回 path 改写为 /workspace', async () => {
    const { inner, guard } = setup();
    inner.downloadFiles.mockResolvedValue([
      {
        path: `${WS}/skills/docx/SKILL.md`,
        content: enc.encode('# Docx'),
        error: null,
      },
    ]);
    const res = await guard.downloadFiles(['/workspace/skills/docx/SKILL.md']);
    expect(inner.downloadFiles).toHaveBeenCalledWith([
      `${WS}/skills/docx/SKILL.md`,
    ]);
    expect(res[0].path).toBe('/workspace/skills/docx/SKILL.md');
  });
});

describe('GuardedSandbox — 技能库只读保护', () => {
  it('write / edit 命中 /workspace/skills/ → 拒绝、inner 未被调用', async () => {
    const { inner, guard } = setup();
    const w = await guard.write('/workspace/skills/docx/SKILL.md', 'x');
    const e = await guard.edit('skills/docx/SKILL.md', 'a', 'b');
    expect(w.error).toContain('/workspace/skills/ 是只读技能库');
    expect(e.error).toContain('只读技能库');
    expect(inner.write).not.toHaveBeenCalled();
    expect(inner.edit).not.toHaveBeenCalled();
  });

  it('非技能路径 → 正常委托 inner', async () => {
    const { inner, guard } = setup();
    await guard.write('/workspace/output/result.md', 'x');
    expect(inner.write).toHaveBeenCalledWith(`${WS}/output/result.md`, 'x');
  });
});

describe('GuardedSandbox — id / isRunning 透传', () => {
  it('id / isRunning 委托 inner', () => {
    const { guard } = setup();
    expect(guard.id).toBe('mock-sandbox-id');
    expect(guard.isRunning).toBe(true);
  });
});
