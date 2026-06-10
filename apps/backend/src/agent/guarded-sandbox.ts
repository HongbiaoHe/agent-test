/**
 * GuardedSandbox — agent 专用目录守卫（官方 §9.5 policy hook 模式）。
 *
 * 包装一个 DaytonaSandbox（或任意 SandboxBackendProtocolV2 实现），
 * 对带路径的文件方法做路径守卫：路径必须等于 workspaceRoot 或以
 * `workspaceRoot + '/'` 开头，否则返回该方法的 error 形状，不 throw。
 *
 * execute：把命令包装为 `cd '<workspaceRoot>' && ( <cmd> )`，锚定 cwd，
 * 使 agent 的相对路径操作天然落在工作区。
 *
 * ⚠️  execute 的安全边界说明：
 *   路径守卫只作用于文件工具（ls/read/readRaw/write/edit/glob/grep）。
 *   execute 仅做 cwd 锚定——绝对路径仍可逃逸工作区（如 `cat /etc/passwd`）。
 *   真正的隔离边界是沙箱本身（Daytona 用户级容器）；本守卫的目标是：
 *     1) 文件工具层面的硬限制（agent 调 write_file/read_file 无法出域）；
 *     2) execute 工作目录锚定（相对路径安全，绝对路径由沙箱隔离保证）。
 *
 * isSandboxProtocol duck-typing 检测：execute 是 function、id 是非空 string。
 * GuardedSandbox 满足两者（委托 inner.execute，id getter 委托 inner.id）。
 *
 * getWorkDir() 覆写为直接返回 workspaceRoot——conversations 文件接口的
 * listFiles/downloadFile 调用 sb.getWorkDir() 后自动只看工作区，无需其他改动。
 *
 * uploadFiles / downloadFiles / start / isRunning / id 等 host 侧方法原样透传——
 * 技能同步要传 /skills/...，文件接口要下载产物，这些是宿主代码（可信路径）。
 */

import path from 'node:path';
import type { DaytonaSandbox } from '@langchain/daytona';
import type {
  EditResult,
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from 'deepagents';

export class GuardedSandbox {
  /** 满足 isSandboxProtocol duck-typing：id 委托给 inner */
  get id(): string {
    return this.inner.id;
  }

  /** 满足 DaytonaSandbox.isRunning 透传（caller 做 isRunning 检查） */
  get isRunning(): boolean {
    return this.inner.isRunning;
  }

  constructor(
    private readonly inner: DaytonaSandbox,
    readonly workspaceRoot: string,
  ) {}

  // ─── 路径守卫辅助 ─────────────────────────────────────────────────────────

  /**
   * 检查路径是否在工作区内。
   * 规范化（posix resolve）后必须等于 workspaceRoot 或以 `workspaceRoot + '/'` 开头。
   * 使用 path.posix.resolve 防 `../` 逃逸。
   */
  private isAllowed(p: string): boolean {
    const normalized = path.posix.resolve(this.workspaceRoot, p.startsWith('/') ? p : `/${p}`);
    return normalized === this.workspaceRoot || normalized.startsWith(this.workspaceRoot + '/');
  }

  private denyMsg(p: string): string {
    return `路径超出 agent 工作区（仅允许 ${this.workspaceRoot} 内）：${p}`;
  }

  // ─── 文件方法（含路径守卫）────────────────────────────────────────────────

  async ls(p: string): Promise<LsResult> {
    if (!this.isAllowed(p)) return { error: this.denyMsg(p) };
    return this.inner.ls(p);
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    if (!this.isAllowed(filePath)) return { error: this.denyMsg(filePath) };
    return this.inner.read(filePath, offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    if (!this.isAllowed(filePath)) return { error: this.denyMsg(filePath) };
    return this.inner.readRaw(filePath);
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    if (!this.isAllowed(filePath)) return { error: this.denyMsg(filePath) };
    return this.inner.write(filePath, content);
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    if (!this.isAllowed(filePath)) return { error: this.denyMsg(filePath) };
    return this.inner.edit(filePath, oldString, newString, replaceAll);
  }

  async glob(pattern: string, searchPath?: string): Promise<GlobResult> {
    const p = searchPath ?? this.workspaceRoot;
    if (!this.isAllowed(p)) return { error: this.denyMsg(p) };
    return this.inner.glob(pattern, searchPath);
  }

  async grep(
    pattern: string,
    searchPath?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    const p = searchPath ?? this.workspaceRoot;
    if (p !== null && p !== undefined && !this.isAllowed(p)) {
      return { error: this.denyMsg(p) };
    }
    return this.inner.grep(pattern, searchPath ?? undefined, glob ?? undefined);
  }

  // ─── execute（cwd 锚定，无路径级硬隔离——见文件顶部说明）─────────────────

  async execute(command: string): Promise<ExecuteResponse> {
    // 用单引号包围路径防空格，workspaceRoot 本身不含单引号（Daytona 路径约定）
    return this.inner.execute(`cd '${this.workspaceRoot}' && ( ${command} )`);
  }

  // ─── getWorkDir 覆写——conversations 文件接口通过此方法确定下载根路径 ────

  async getWorkDir(): Promise<string> {
    return this.workspaceRoot;
  }

  // ─── host 侧方法：原样透传（可信宿主代码，技能同步/文件接口使用）────────

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.inner.uploadFiles(files);
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.inner.downloadFiles(paths);
  }

  async start(timeout?: number): Promise<void> {
    return this.inner.start(timeout);
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
