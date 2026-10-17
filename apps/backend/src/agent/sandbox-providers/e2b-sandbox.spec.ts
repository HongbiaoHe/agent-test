/**
 * E2BSandbox 单测：execute 退出码/输出合并、文件错误码映射、活跃续期节流。
 * e2b SDK / deepagents 为 ESM 包（jest 加载失败）：e2b 按其导出的错误类形状 mock；
 * deepagents 只用到 BaseSandbox 基类（被测方法均由 E2BSandbox 自身实现），给空类即可。
 */
jest.mock('deepagents', () => ({ BaseSandbox: class {} }));
jest.mock('e2b', () => {
  class SandboxError extends Error {}
  class CommandExitError extends SandboxError {
    constructor(
      readonly exitCode: number,
      readonly stdout: string,
      readonly stderr: string,
    ) {
      super(`exit ${exitCode}`);
    }
  }
  class FileNotFoundError extends SandboxError {}
  class InvalidArgumentError extends SandboxError {}
  return { CommandExitError, FileNotFoundError, InvalidArgumentError };
});

import {
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  type Sandbox,
} from 'e2b';
import { E2BSandbox, mapFileError } from './e2b-sandbox';

/** mock 构造器签名与真实 SDK 不同（真实接收 CommandResult），经 unknown 适配到测试用形状。 */
const ExitError = CommandExitError as unknown as new (
  exitCode: number,
  stdout: string,
  stderr: string,
) => Error;
const NotFound = FileNotFoundError as unknown as new (msg: string) => Error;
const InvalidArg = InvalidArgumentError as unknown as new (
  msg: string,
) => Error;

function makeSbx() {
  return {
    sandboxId: 'e2b-1',
    setTimeout: jest.fn().mockResolvedValue(undefined),
    commands: { run: jest.fn() },
    files: { write: jest.fn(), read: jest.fn() },
    connect: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(true),
    kill: jest.fn().mockResolvedValue(true),
  };
}

const IDLE = 300_000;

/** commands.run(…, { background: true }) 返回的句柄：wait 的结局由参数决定。 */
function handle(
  outcome:
    | { result: { exitCode: number; stdout: string; stderr: string } }
    | { error: Error }
    | 'hang',
  partial = { stdout: '', stderr: '' },
) {
  return {
    ...partial,
    wait: jest.fn(() =>
      outcome === 'hang'
        ? new Promise(() => {})
        : 'error' in outcome
          ? Promise.reject(outcome.error)
          : Promise.resolve(outcome.result),
    ),
    kill: jest.fn().mockResolvedValue(true),
  };
}

describe('E2BSandbox', () => {
  let sbx: ReturnType<typeof makeSbx>;
  let e2b: E2BSandbox;

  beforeEach(() => {
    sbx = makeSbx();
    e2b = new E2BSandbox(sbx as unknown as Sandbox, IDLE);
  });

  afterEach(() => jest.useRealTimers());

  it('id 取 sandboxId', () => {
    expect(e2b.id).toBe('e2b-1');
  });

  it('execute 成功：background 模式跑、等 shell 退出；stdout/stderr 合并、exitCode 透传', async () => {
    sbx.commands.run.mockResolvedValue(
      handle({ result: { exitCode: 0, stdout: 'out', stderr: 'warn' } }),
    );
    expect(await e2b.execute('ls')).toEqual({
      output: 'out\nwarn',
      exitCode: 0,
      truncated: false,
    });
    // 前台 run 会被命令里的后台服务拖到超时，所以一律 background + wait（见文件头）
    expect(sbx.commands.run).toHaveBeenCalledWith('ls', {
      background: true,
      timeoutMs: 0,
    });
  });

  it('execute 超时 → kill 并作为结果返回（124 + 已有输出 + 提示），不抛错拖垮整轮', async () => {
    jest.useFakeTimers();
    const h = handle('hang', { stdout: 'partial', stderr: '' });
    sbx.commands.run.mockResolvedValue(h);
    const p = e2b.execute('npm run dev');
    await jest.advanceTimersByTimeAsync(240_000);
    const r = await p;
    expect(h.kill).toHaveBeenCalled();
    expect(r.exitCode).toBe(124);
    expect(r.output).toContain('partial');
    expect(r.output).toContain('已被终止');
  });

  it('execute 非零退出（SDK 抛 CommandExitError）→ 转成结果而非抛错', async () => {
    sbx.commands.run.mockResolvedValue(
      handle({ error: new ExitError(3, '', 'boom') }),
    );
    expect(await e2b.execute('false')).toEqual({
      output: 'boom',
      exitCode: 3,
      truncated: false,
    });
  });

  it('execute 其他错误（网络等）→ 向上抛', async () => {
    sbx.commands.run.mockRejectedValue(new Error('network down'));
    await expect(e2b.execute('ls')).rejects.toThrow('network down');
  });

  it('uploadFiles：逐个写入、部分失败保持数组对齐', async () => {
    sbx.files.write
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('permission denied'));
    const enc = new TextEncoder();
    const res = await e2b.uploadFiles([
      ['/a.txt', enc.encode('a')],
      ['/b.txt', enc.encode('b')],
    ]);
    expect(res).toEqual([
      { path: '/a.txt', error: null },
      { path: '/b.txt', error: 'permission_denied' },
    ]);
    // 写入的是独立 ArrayBuffer（内容与入参一致）
    const buf = sbx.files.write.mock.calls[0][1] as ArrayBuffer;
    expect(new TextDecoder().decode(buf)).toBe('a');
  });

  it('downloadFiles：按 bytes 读取，缺失文件 → file_not_found', async () => {
    const bytes = new TextEncoder().encode('hi');
    sbx.files.read
      .mockResolvedValueOnce(bytes)
      .mockRejectedValueOnce(new NotFound("path '/x' does not exist"));
    const res = await e2b.downloadFiles(['/a', '/x']);
    expect(res).toEqual([
      { path: '/a', content: bytes, error: null },
      { path: '/x', content: null, error: 'file_not_found' },
    ]);
    expect(sbx.files.read).toHaveBeenCalledWith('/a', { format: 'bytes' });
  });

  it('续期节流：构造后 30s 内不续期，超过后续期为闲置超时', async () => {
    jest.useFakeTimers({ now: Date.now() });
    sbx = makeSbx();
    e2b = new E2BSandbox(sbx as unknown as Sandbox, IDLE);
    sbx.commands.run.mockImplementation(() =>
      Promise.resolve(
        handle({ result: { exitCode: 0, stdout: '', stderr: '' } }),
      ),
    );

    await e2b.execute('a');
    expect(sbx.setTimeout).not.toHaveBeenCalled();

    jest.setSystemTime(Date.now() + 31_000);
    await e2b.execute('b');
    expect(sbx.setTimeout).toHaveBeenCalledWith(IDLE);

    await e2b.execute('c');
    expect(sbx.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('start/stop/close 分别委托 connect(续期)/pause/kill', async () => {
    await e2b.start();
    await e2b.stop();
    await e2b.close();
    expect(sbx.connect).toHaveBeenCalledWith({ timeoutMs: IDLE });
    expect(sbx.pause).toHaveBeenCalled();
    expect(sbx.kill).toHaveBeenCalled();
  });
});

describe('mapFileError', () => {
  it('FileNotFoundError → file_not_found', () => {
    expect(mapFileError(new NotFound('nope'))).toBe('file_not_found');
  });
  it('InvalidArgumentError "is a directory" → is_directory', () => {
    expect(
      mapFileError(new InvalidArg("path '/home/user' is a directory")),
    ).toBe('is_directory');
  });
  it('含 permission → permission_denied', () => {
    expect(mapFileError(new Error('Permission denied'))).toBe(
      'permission_denied',
    );
  });
  it('其余 → invalid_path', () => {
    expect(mapFileError('weird')).toBe('invalid_path');
  });
});
