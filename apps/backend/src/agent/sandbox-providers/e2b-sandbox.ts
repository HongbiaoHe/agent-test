/**
 * E2BSandbox：把 E2B SDK 的 Sandbox 适配成 deepagents BaseSandbox。
 *
 * BaseSandbox 只要求实现 execute / uploadFiles / downloadFiles，ls/read/write/edit/
 * glob/grep 由它基于 POSIX shell（经 execute）实现（deepagents dist/index.d.ts BaseSandbox）。
 * LangChain 没有官方 E2B 包（npm 无 @langchain/e2b），故自写。
 *
 * ─── 验证过的 E2B 事实（e2b@2.51.0 + 2026-10-14 真实 API 冒烟实验）────────────
 *  · commands.run 非零退出码会抛 CommandExitError（带 exitCode/stdout/stderr），
 *    不是返回结果——须 catch 后转成 ExecuteResponse，否则 agent 拿不到失败输出。
 *  · commands.run 默认超时 60s（CommandStartOpts.timeoutMs），这里放宽到 4 分钟。
 *  · files.write 自动创建父目录；files.read(path, { format: 'bytes' }) 返回 Uint8Array。
 *  · 读不存在文件抛 FileNotFoundError；读目录抛 InvalidArgumentError（"is a directory"）。
 *  · 沙箱超时是**绝对时长**（不是闲置计时）：到期即按 lifecycle 暂停，执行中的命令
 *    不会续命。所以每次操作前用 setTimeout 续期（节流），保证活跃使用期间不被暂停。
 * ──────────────────────────────────────────────────────────────────────
 */

import {
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  type Sandbox,
} from 'e2b';
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from 'deepagents';

/** 单条命令超时：须小于闲置超时，保证命令跑完前沙箱不会因到期被暂停。 */
const COMMAND_TIMEOUT_MS = 4 * 60_000;
/** 续期节流：距上次续期不足该间隔就跳过，避免每个文件操作都打一次 API。 */
const TOUCH_THROTTLE_MS = 30_000;

export class E2BSandbox extends BaseSandbox {
  readonly id: string;
  private lastTouchAt: number;

  /**
   * @param sbx 已连接（运行中）的 E2B Sandbox
   * @param idleTimeoutMs 闲置超时：最后一次操作后多久自动暂停
   */
  constructor(
    private readonly sbx: Sandbox,
    private readonly idleTimeoutMs: number,
  ) {
    super();
    this.id = sbx.sandboxId;
    // create / connect 时已按 idleTimeoutMs 设过超时，视为刚续期
    this.lastTouchAt = Date.now();
  }

  /** 与 DaytonaSandbox.isRunning 同语义：实例已连接（不代表远端真实状态）。 */
  get isRunning(): boolean {
    return true;
  }

  /** 活跃续期：把沙箱到期时间重设为「现在 + 闲置超时」（节流）。 */
  private async touch(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTouchAt < TOUCH_THROTTLE_MS) return;
    this.lastTouchAt = now;
    await this.sbx.setTimeout(this.idleTimeoutMs);
  }

  async execute(command: string): Promise<ExecuteResponse> {
    await this.touch();
    try {
      const r = await this.sbx.commands.run(command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      return toResponse(r.stdout, r.stderr, r.exitCode);
    } catch (e) {
      if (e instanceof CommandExitError) {
        return toResponse(e.stdout, e.stderr, e.exitCode);
      }
      throw e;
    }
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    await this.touch();
    return Promise.all(
      files.map(async ([path, content]): Promise<FileUploadResponse> => {
        try {
          // 复制成独立 ArrayBuffer：入参 Uint8Array 可能是更大 buffer 的视图
          await this.sbx.files.write(path, new Uint8Array(content).buffer);
          return { path, error: null };
        } catch (e) {
          return { path, error: mapFileError(e) };
        }
      }),
    );
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    await this.touch();
    return Promise.all(
      paths.map(async (path): Promise<FileDownloadResponse> => {
        try {
          const content = await this.sbx.files.read(path, { format: 'bytes' });
          return { path, content, error: null };
        } catch (e) {
          return { path, content: null, error: mapFileError(e) };
        }
      }),
    );
  }

  /** 拉起（暂停态则恢复），并按闲置超时续期。 */
  async start(): Promise<void> {
    await this.sbx.connect({ timeoutMs: this.idleTimeoutMs });
    this.lastTouchAt = Date.now();
  }

  /** 暂停（E2B 暂停态保留文件系统与内存，等价 Daytona 停机）。 */
  async stop(): Promise<void> {
    await this.sbx.pause();
  }

  /** 销毁沙箱（与 DaytonaSandbox.close 同语义：删除远端实例）。 */
  async close(): Promise<void> {
    await this.sbx.kill();
  }
}

/** stdout/stderr 合并口径与 deepagents 官方 LangSmithSandbox.execute 一致。 */
function toResponse(
  stdout: string,
  stderr: string,
  exitCode: number,
): ExecuteResponse {
  const output = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
  return { output, exitCode, truncated: false };
}

/** E2B 文件错误 → deepagents 标准化错误码。 */
export function mapFileError(e: unknown): FileOperationError {
  if (e instanceof FileNotFoundError) return 'file_not_found';
  const msg = e instanceof Error ? e.message.toLowerCase() : '';
  if (e instanceof InvalidArgumentError && msg.includes('is a directory')) {
    return 'is_directory';
  }
  if (msg.includes('permission')) return 'permission_denied';
  return 'invalid_path';
}
