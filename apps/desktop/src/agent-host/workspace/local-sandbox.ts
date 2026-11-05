/**
 * 本机工作区沙箱：给 GuardedSandbox 当 inner（GuardableSandbox）。
 *
 * - 文件工具（ls / read / write / edit / glob / grep / upload / download）委托 deepagents 的
 *   FilesystemBackend（virtualMode=false：路径就是真实路径；越界由外层 GuardedSandbox 拦）。
 * - execute 自己实现，不用 LocalShellBackend.execute：
 *   1) 每条命令起独立进程组（detached），超时 / 停止运行时 kill(-pgid) 整棵树一起杀，
 *      不留后台孤儿进程（LocalShellBackend.execute 不接 abort 信号）；
 *   2) 环境变量只给白名单（PATH / HOME / LANG / TMPDIR …），agent-host 进程里的模型 Key
 *      不会被命令意外打印出来——这只防误泄露，不是隔离：shell 能访问整台电脑，边界是审批门。
 *
 * 注意：GuardedSandbox.execute 会包一层 `cd '<root>' && ( … )`，工作区路径不得含单引号
 * （settings 写入时已校验）。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { GuardableSandbox } from '@agent-test/agent-core/agent/guardable-sandbox';
import {
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  FilesystemBackend,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from 'deepagents';

export interface LocalSandboxOptions {
  /** 单条命令超时（毫秒），默认 120s（与 LocalShellBackend 默认值一致） */
  timeoutMs?: number;
  /** 命令输出上限（字节），默认 100_000（同上） */
  maxOutputBytes?: number;
  /** 子进程环境变量（白名单之外的不传） */
  env?: Record<string, string>;
  /** 命令登记表：崩溃后由下次启动的 agent-host 清理孤儿进程组 */
  tracker?: { add(pgid: number, commandLine: string): void; remove(pgid: number): void };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 100_000;
const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL', 'TERM'];

/** 从当前进程环境里挑出允许传给命令的变量；PATH 补上 Homebrew 常见路径（从 Finder 启动时 PATH 很短） */
export function whitelistedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_WHITELIST) {
    const v = source[k];
    if (v) env[k] = v;
  }
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = (env.PATH ?? '').split(':').filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  return env;
}

export class LocalWorkspaceSandbox implements GuardableSandbox {
  readonly id = `local-${randomBytes(4).toString('hex')}`;
  private readonly fs: FilesystemBackend;
  private readonly running = new Set<ChildProcess>();
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: Record<string, string>;
  private readonly tracker: LocalSandboxOptions['tracker'];

  constructor(
    readonly root: string,
    opts: LocalSandboxOptions = {},
  ) {
    this.fs = new FilesystemBackend({ rootDir: root, virtualMode: false });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.env = opts.env ?? whitelistedEnv();
    this.tracker = opts.tracker;
  }

  // ── 生命周期：本机没有远端资源，start/stop 只管子进程 ───────────────────────

  get isRunning(): boolean {
    return true;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  /** 停止运行时调用：杀掉所有仍在跑的命令（整个进程组） */
  stop(): Promise<void> {
    for (const child of this.running) killTree(child);
    this.running.clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.stop();
  }

  // ── execute ───────────────────────────────────────────────────────────────

  execute(command: string): Promise<ExecuteResponse> {
    return new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: this.root,
        env: this.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running.add(child);
      const pid = child.pid;
      // ps 显示的命令行就是 argv 用空格拼起来的样子（reapOrphans 据此核对，防 pid 复用误杀）
      if (pid !== undefined) this.tracker?.add(pid, `/bin/bash -c ${command}`);
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (buf: Buffer) => {
        if (size >= this.maxOutputBytes) {
          truncated = true;
          return;
        }
        const room = this.maxOutputBytes - size;
        const part = buf.length > room ? buf.subarray(0, room) : buf;
        if (part.length < buf.length) truncated = true;
        chunks.push(part);
        size += part.length;
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.timeoutMs);
      const finish = (exitCode: number) => {
        clearTimeout(timer);
        this.running.delete(child);
        if (pid !== undefined) this.tracker?.remove(pid);
        let output = Buffer.concat(chunks).toString('utf8');
        if (truncated) output += `\n…（输出超过 ${this.maxOutputBytes} 字节，已截断）`;
        if (timedOut) {
          output += `\n命令超过 ${Math.round(this.timeoutMs / 1000)} 秒未结束，已终止。`;
        }
        resolve({ output, exitCode, truncated });
      };
      child.on('error', (e) => {
        collect(Buffer.from(String(e)));
        finish(127);
      });
      child.on('close', (code, signal) => finish(code ?? (signal ? 137 : 1)));
    });
  }

  // ── 文件工具：委托 FilesystemBackend ─────────────────────────────────────────

  ls(path: string): Promise<LsResult> {
    return this.fs.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.fs.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.fs.readRaw(filePath);
  }

  grep(pattern: string, path?: string, glob?: string | null): Promise<GrepResult> {
    return this.fs.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.fs.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<WriteResult> {
    return this.fs.write(filePath, content);
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    return this.fs.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.fs.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.fs.downloadFiles(paths);
  }
}

/** 杀整个进程组（detached 让子进程自成一组，pgid = pid）；组已不存在时忽略 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
