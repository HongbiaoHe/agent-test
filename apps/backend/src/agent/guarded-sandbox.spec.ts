/**
 * GuardedSandbox 单测（虚拟根目录语义）
 *
 * inner 用手写 mock（不依赖 deepagents 运行时）。
 * 规则：
 *  - 入站映射：'/'→ws、'/foo'→ws/foo、相对 'foo'→ws/foo、真实 ws 路径原样接受
 *  - `../` 逃逸到区外 → 返回 error 形状、inner 未被调用、错误消息不含真实路径
 *  - 出站脱敏：结果里的真实 ws 前缀替换回 '/'（含 execute 输出）；readRaw.data 不动
 *  - execute → inner 收到 `cd '<ws>' && ( 原命令 )`，输出脱敏
 *  - getWorkDir → 返回真实 workspaceRoot（宿主侧用）
 *  - uploadFiles → 透传（/skills/... 路径不拦截）
 */

// GuardedSandbox 不依赖 deepagents 运行时，无需 jest.mock
import { GuardedSandbox } from './guarded-sandbox';

const WS = '/home/user/agent-workspace';

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

describe('GuardedSandbox — 入站虚拟路径映射', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    inner = makeMockInner();
    guard = new GuardedSandbox(inner as any, WS);
  });

  it("ls('/') → 映射到工作区根", async () => {
    await guard.ls('/');
    expect(inner.ls).toHaveBeenCalledWith(WS);
  });

  it("ls('/sub') 虚拟绝对路径 → ws/sub", async () => {
    await guard.ls('/sub');
    expect(inner.ls).toHaveBeenCalledWith(`${WS}/sub`);
  });

  it("ls('sub') 相对路径 → ws/sub", async () => {
    await guard.ls('sub');
    expect(inner.ls).toHaveBeenCalledWith(`${WS}/sub`);
  });

  it('ls: 真实工作区路径原样接受（兼容 execute 输出里学到的路径）', async () => {
    const p = `${WS}/subdir`;
    await guard.ls(p);
    expect(inner.ls).toHaveBeenCalledWith(p);
  });

  it("ls('/etc/passwd') → 虚拟化进工作区（ws/etc/passwd），不会触及真实 /etc", async () => {
    await guard.ls('/etc/passwd');
    expect(inner.ls).toHaveBeenCalledWith(`${WS}/etc/passwd`);
  });

  it('ls: ../ 逃逸 → error，inner 未被调用，且错误不含真实路径', async () => {
    const result = await guard.ls(`${WS}/../secret`);
    expect(result.error).toMatch(/工作目录/);
    expect(result.error).not.toContain(WS);
    expect(inner.ls).not.toHaveBeenCalled();
  });

  it("ls('/a/../../etc') 虚拟路径里的 ../ 逃逸 → error", async () => {
    const result = await guard.ls('/a/../../etc');
    expect(result.error).toMatch(/工作目录/);
    expect(result.error).not.toContain(WS);
    expect(inner.ls).not.toHaveBeenCalled();
  });

  it("read('../secret.txt') 相对逃逸 → error，inner 未被调用", async () => {
    const result = await guard.read('../secret.txt');
    expect(result.error).toMatch(/工作目录/);
    expect(inner.read).not.toHaveBeenCalled();
  });

  it('read: 虚拟路径 + offset/limit 透传', async () => {
    await guard.read('/file.txt', 0, 100);
    expect(inner.read).toHaveBeenCalledWith(`${WS}/file.txt`, 0, 100);
  });

  it('write: 虚拟路径映射 + 内容透传', async () => {
    await guard.write('/out.txt', 'hello');
    expect(inner.write).toHaveBeenCalledWith(`${WS}/out.txt`, 'hello');
  });

  it('write: ../ 逃逸 → error，inner 未被调用', async () => {
    const result = await guard.write(`${WS}/../evil.txt`, 'x');
    expect(result.error).toMatch(/工作目录/);
    expect(inner.write).not.toHaveBeenCalled();
  });

  it('edit: 虚拟路径映射 + 参数透传', async () => {
    await guard.edit('/file.txt', 'old', 'new', false);
    expect(inner.edit).toHaveBeenCalledWith(
      `${WS}/file.txt`,
      'old',
      'new',
      false,
    );
  });

  it('readRaw: 虚拟路径映射', async () => {
    await guard.readRaw('/image.png');
    expect(inner.readRaw).toHaveBeenCalledWith(`${WS}/image.png`);
  });

  it('glob: 缺省 searchPath → 显式锚定工作区根', async () => {
    await guard.glob('**/*.ts');
    expect(inner.glob).toHaveBeenCalledWith('**/*.ts', WS);
  });

  it('glob: 虚拟 searchPath → 映射进工作区', async () => {
    await guard.glob('**/*.ts', '/src');
    expect(inner.glob).toHaveBeenCalledWith('**/*.ts', `${WS}/src`);
  });

  it('grep: null searchPath → 显式锚定工作区根', async () => {
    await guard.grep('TODO', null);
    expect(inner.grep).toHaveBeenCalledWith('TODO', WS, undefined);
  });

  it('grep: 逃逸 searchPath → error，inner 未被调用', async () => {
    const result = await guard.grep('secret', '../..');
    expect(result.error).toMatch(/工作目录/);
    expect(inner.grep).not.toHaveBeenCalled();
  });
});

describe('GuardedSandbox — 出站脱敏（真实路径 → 虚拟 /）', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    inner = makeMockInner();
    guard = new GuardedSandbox(inner as any, WS);
  });

  it('ls 结果里的真实路径替换回虚拟 /', async () => {
    inner.ls.mockResolvedValue({
      files: [
        { path: `${WS}/a.txt`, isDir: false },
        { path: `${WS}/sub`, isDir: true },
      ],
    });
    const result = await guard.ls('/');
    expect(result).toEqual({
      files: [
        { path: '/a.txt', isDir: false },
        { path: '/sub', isDir: true },
      ],
    });
  });

  it('write 回显路径脱敏', async () => {
    inner.write.mockResolvedValue({ path: `${WS}/out.txt` });
    const result = await guard.write('/out.txt', 'x');
    expect(result).toEqual({ path: '/out.txt' });
  });

  it('inner 返回的 error 消息里出现真实路径也被脱敏', async () => {
    inner.read.mockResolvedValue({ error: `file not found: ${WS}/nope.txt` });
    const result = await guard.read('/nope.txt');
    expect(result).toEqual({ error: 'file not found: /nope.txt' });
  });

  it('execute 输出里的真实路径（如 pwd）替换为 /', async () => {
    inner.execute.mockResolvedValue({
      output: `${WS}\n${WS}/dist/out.docx\n`,
      exitCode: 0,
      truncated: false,
    });
    const result = await guard.execute('pwd && ls dist');
    expect(result.output).toBe('/\n/dist/out.docx\n');
  });

  it('readRaw 的 data 字段不做字符串替换（二进制/base64 安全）', async () => {
    const data = { base64: `${WS}-looking-string-stays` };
    inner.readRaw.mockResolvedValue({ data });
    const result = (await guard.readRaw('/image.png')) as unknown as {
      data: typeof data;
    };
    expect(result.data).toBe(data);
  });
});

describe('GuardedSandbox — execute cwd 锚定', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    inner = makeMockInner();
    guard = new GuardedSandbox(inner as any, WS);
  });

  it("execute: inner 收到 `cd '<ws>' && ( 原命令 )`", async () => {
    await guard.execute('ls -la');
    expect(inner.execute).toHaveBeenCalledWith(`cd '${WS}' && ( ls -la )`);
  });

  it('execute: 复杂命令也完整包装', async () => {
    const cmd = 'python3 /skills/docx/scripts/run.py --input input.txt';
    await guard.execute(cmd);
    expect(inner.execute).toHaveBeenCalledWith(`cd '${WS}' && ( ${cmd} )`);
  });
});

describe('GuardedSandbox — getWorkDir', () => {
  it('getWorkDir 返回真实 workspaceRoot（仅宿主侧使用）', async () => {
    const inner = makeMockInner();
    const guard = new GuardedSandbox(inner as any, WS);
    const result = await guard.getWorkDir();
    expect(result).toBe(WS);
    // inner.getWorkDir 不应被调用（直接返回 workspaceRoot）
    expect(inner.getWorkDir).not.toHaveBeenCalled();
  });
});

describe('GuardedSandbox — uploadFiles 透传', () => {
  it('uploadFiles: /skills/... 路径 → 直接委托 inner，不拦截', async () => {
    const inner = makeMockInner();
    const guard = new GuardedSandbox(inner as any, WS);
    const enc = new TextEncoder();
    const files: Array<[string, Uint8Array]> = [
      ['/skills/docx/SKILL.md', enc.encode('# Docx Skill')],
    ];
    await guard.uploadFiles(files);
    expect(inner.uploadFiles).toHaveBeenCalledWith(files);
  });
});

describe('GuardedSandbox — id / isRunning 透传', () => {
  it('id getter 返回 inner.id', () => {
    const inner = makeMockInner();
    const guard = new GuardedSandbox(inner as any, WS);
    expect(guard.id).toBe('mock-sandbox-id');
  });

  it('isRunning getter 返回 inner.isRunning', () => {
    const inner = makeMockInner();
    const guard = new GuardedSandbox(inner as any, WS);
    expect(guard.isRunning).toBe(true);
  });
});
