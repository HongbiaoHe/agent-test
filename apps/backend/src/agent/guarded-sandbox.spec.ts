/**
 * GuardedSandbox 单测
 *
 * inner 用手写 mock（不依赖 deepagents 运行时）。
 * 规则：
 *  - 工作区内路径 → 委托调用（inner 收到原路径）
 *  - 工作区外路径（绝对 /etc/passwd、../逃逸）→ 返回 error 形状、inner 未被调用
 *  - execute → inner 收到 `cd '<ws>' && ( 原命令 )`
 *  - getWorkDir → 返回 workspaceRoot
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
    execute: jest.fn().mockResolvedValue({ output: '', exitCode: 0, truncated: false }),
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

describe('GuardedSandbox — 路径守卫', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    inner = makeMockInner();
    guard = new GuardedSandbox(inner as any, WS);
  });

  // ── ls ──────────────────────────────────────────────────────────────────

  it('ls: 工作区内路径 → 委托 inner，传入原路径', async () => {
    const p = `${WS}/subdir`;
    await guard.ls(p);
    expect(inner.ls).toHaveBeenCalledWith(p);
  });

  it('ls: 工作区根路径 → 委托 inner', async () => {
    await guard.ls(WS);
    expect(inner.ls).toHaveBeenCalledWith(WS);
  });

  it('ls: /etc/passwd → error，inner 未被调用', async () => {
    const result = await guard.ls('/etc/passwd');
    expect(result.error).toMatch(/工作区/);
    expect(inner.ls).not.toHaveBeenCalled();
  });

  it('ls: ../逃逸路径 → error，inner 未被调用', async () => {
    const result = await guard.ls(`${WS}/../secret`);
    expect(result.error).toMatch(/工作区/);
    expect(inner.ls).not.toHaveBeenCalled();
  });

  // ── read ─────────────────────────────────────────────────────────────────

  it('read: 工作区内路径 → 委托 inner', async () => {
    const p = `${WS}/file.txt`;
    await guard.read(p, 0, 100);
    expect(inner.read).toHaveBeenCalledWith(p, 0, 100);
  });

  it('read: /etc/passwd → error，inner 未被调用', async () => {
    const result = await guard.read('/etc/passwd');
    expect(result.error).toMatch(/工作区/);
    expect(inner.read).not.toHaveBeenCalled();
  });

  it('read: ../逃逸 → error，inner 未被调用', async () => {
    const result = await guard.read(`${WS}/../secret.txt`);
    expect(result.error).toMatch(/工作区/);
    expect(inner.read).not.toHaveBeenCalled();
  });

  // ── readRaw ───────────────────────────────────────────────────────────────

  it('readRaw: 工作区内 → 委托 inner', async () => {
    const p = `${WS}/image.png`;
    await guard.readRaw(p);
    expect(inner.readRaw).toHaveBeenCalledWith(p);
  });

  it('readRaw: 区外 → error，inner 未被调用', async () => {
    const result = await guard.readRaw('/tmp/evil');
    expect(result.error).toMatch(/工作区/);
    expect(inner.readRaw).not.toHaveBeenCalled();
  });

  // ── write ─────────────────────────────────────────────────────────────────

  it('write: 工作区内 → 委托 inner', async () => {
    const p = `${WS}/out.txt`;
    await guard.write(p, 'hello');
    expect(inner.write).toHaveBeenCalledWith(p, 'hello');
  });

  it('write: /etc/evil.txt → error，inner 未被调用', async () => {
    const result = await guard.write('/etc/evil.txt', 'x');
    expect(result.error).toMatch(/工作区/);
    expect(inner.write).not.toHaveBeenCalled();
  });

  it('write: ../逃逸 → error，inner 未被调用', async () => {
    const result = await guard.write(`${WS}/../evil.txt`, 'x');
    expect(result.error).toMatch(/工作区/);
    expect(inner.write).not.toHaveBeenCalled();
  });

  // ── edit ─────────────────────────────────────────────────────────────────

  it('edit: 工作区内 → 委托 inner', async () => {
    const p = `${WS}/file.txt`;
    await guard.edit(p, 'old', 'new', false);
    expect(inner.edit).toHaveBeenCalledWith(p, 'old', 'new', false);
  });

  it('edit: 区外 → error，inner 未被调用', async () => {
    const result = await guard.edit('/etc/hosts', 'a', 'b');
    expect(result.error).toMatch(/工作区/);
    expect(inner.edit).not.toHaveBeenCalled();
  });

  // ── glob ─────────────────────────────────────────────────────────────────

  it('glob: 工作区内路径 → 委托 inner', async () => {
    const p = `${WS}/src`;
    await guard.glob('**/*.ts', p);
    expect(inner.glob).toHaveBeenCalledWith('**/*.ts', p);
  });

  it('glob: 无 searchPath → 使用 workspaceRoot，委托 inner', async () => {
    await guard.glob('**/*.ts');
    expect(inner.glob).toHaveBeenCalledWith('**/*.ts', undefined);
  });

  it('glob: 区外 searchPath → error，inner 未被调用', async () => {
    const result = await guard.glob('**/*', '/etc');
    expect(result.error).toMatch(/工作区/);
    expect(inner.glob).not.toHaveBeenCalled();
  });

  // ── grep ─────────────────────────────────────────────────────────────────

  it('grep: 工作区内路径 → 委托 inner', async () => {
    const p = `${WS}/src`;
    await guard.grep('TODO', p);
    expect(inner.grep).toHaveBeenCalledWith('TODO', p, undefined);
  });

  it('grep: null path → 委托 inner（inner 用工作区默认）', async () => {
    await guard.grep('TODO', null);
    expect(inner.grep).toHaveBeenCalledWith('TODO', undefined, undefined);
  });

  it('grep: 区外路径 → error，inner 未被调用', async () => {
    const result = await guard.grep('secret', '/var/log');
    expect(result.error).toMatch(/工作区/);
    expect(inner.grep).not.toHaveBeenCalled();
  });
});

describe('GuardedSandbox — execute cwd 锚定', () => {
  let inner: ReturnType<typeof makeMockInner>;
  let guard: GuardedSandbox;

  beforeEach(() => {
    inner = makeMockInner();
    guard = new GuardedSandbox(inner as any, WS);
  });

  it('execute: inner 收到 `cd \'<ws>\' && ( 原命令 )`', async () => {
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
  it('getWorkDir 返回 workspaceRoot', async () => {
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
