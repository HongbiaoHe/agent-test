/**
 * GuardedSandbox — agent 专用目录守卫 + 虚拟根目录（官方 §9.5 policy hook 模式）。
 *
 * 包装一个 DaytonaSandbox（或任意 SandboxBackendProtocolV2 实现），把工作区
 * （workspaceRoot，如 /home/daytona/agent-workspace）虚拟化为 agent 眼中的 `/`：
 *
 *  - 入站（agent → 沙箱）：文件方法的路径按虚拟根解析——
 *      `/` 或 ''        → workspaceRoot
 *      `/foo`、`foo`    → `${workspaceRoot}/foo`
 *      真实工作区路径    → 原样接受（兼容 agent 从 execute 输出等处拿到的真实路径）
 *      `../` 逃逸到区外 → 返回 error 形状（不 throw），消息不含真实路径
 *  - 出站（沙箱 → agent）：结果对象深度遍历，把字符串里的 workspaceRoot 前缀
 *      替换回 `/`（ls/glob/grep 的文件路径、write/edit 的回显路径、execute 输出里的
 *      pwd 等），agent 全程看不到真实路径。readRaw 的 data（二进制/base64）不做替换。
 *
 * ⚠️  execute 的安全边界说明：
 *   路径守卫只作用于文件工具（ls/read/readRaw/write/edit/glob/grep）。
 *   execute 仅做 cwd 锚定 + 输出脱敏——绝对路径仍可逃逸工作区（如 `cat /etc/passwd`）。
 *   真正的隔离边界是沙箱本身（Daytona 用户级容器）；本守卫的目标是：
 *     1) 文件工具层面的硬限制（agent 调 write_file/read_file 无法出域）；
 *     2) execute 工作目录锚定（相对路径安全，绝对路径由沙箱隔离保证）；
 *     3) 真实路径不进入模型上下文（理解为「工作目录就是 /」即可）。
 *
 * isSandboxProtocol duck-typing 检测：execute 是 function、id 是非空 string。
 * GuardedSandbox 满足两者（委托 inner.execute，id getter 委托 inner.id）。
 *
 * getWorkDir() 覆写为直接返回 workspaceRoot（真实路径）——它只被宿主侧代码使用
 * （conversations 文件接口的 listFiles/downloadFile），不进入模型上下文。
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

  // ─── 虚拟根映射 ───────────────────────────────────────────────────────────

  /**
   * 入站：agent 的（虚拟/相对/真实）路径 → 工作区内真实路径；逃逸到区外 → null。
   * posix.resolve 规范化 `../`，防逃逸。
   */
  private toReal(p: string): string | null {
    let real: string;
    if (p === '' || p === '/') {
      real = this.workspaceRoot;
    } else if (
      p === this.workspaceRoot ||
      p.startsWith(this.workspaceRoot + '/')
    ) {
      // agent 可能从 execute 输出（pwd 等）拿到真实路径，原样接受
      real = path.posix.resolve(p);
    } else {
      // 虚拟绝对路径 `/foo` 与相对路径 `foo` 都按工作区根解析
      real = path.posix.resolve(
        this.workspaceRoot,
        p.startsWith('/') ? `.${p}` : p,
      );
    }
    if (
      real === this.workspaceRoot ||
      real.startsWith(this.workspaceRoot + '/')
    )
      return real;
    return null;
  }

  /** 出站：字符串里的真实工作区前缀替换回虚拟根 `/`。 */
  private toVirtual(s: string): string {
    return s
      .replaceAll(this.workspaceRoot + '/', '/')
      .replaceAll(this.workspaceRoot, '/');
  }

  /** 出站：结果对象深度遍历脱敏（字符串 → toVirtual；数组/对象递归；其余原样）。 */
  private sanitize<T>(value: T): T {
    if (typeof value === 'string') return this.toVirtual(value) as T;
    if (Array.isArray(value))
      return value.map((v: unknown) => this.sanitize(v)) as unknown as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.sanitize(v),
        ]),
      ) as T;
    }
    return value;
  }

  /** 拒绝消息：不暴露真实路径，按虚拟根口径表述（回显的入参路径同样脱敏）。 */
  private denyMsg(p: string): string {
    return `路径超出 agent 工作目录（你的工作目录是 /，仅可访问其中的路径）：${this.toVirtual(p)}`;
  }

  // ─── 文件方法（含路径守卫 + 出入站映射）──────────────────────────────────

  async ls(p: string): Promise<LsResult> {
    const real = this.toReal(p);
    if (!real) return { error: this.denyMsg(p) };
    return this.sanitize(await this.inner.ls(real));
  }

  async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const real = this.toReal(filePath);
    if (!real) return { error: this.denyMsg(filePath) };
    return this.sanitize(await this.inner.read(real, offset, limit));
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const real = this.toReal(filePath);
    if (!real) return { error: this.denyMsg(filePath) };
    // data 可能是二进制/base64，不做字符串替换；仅 error 字段脱敏
    const result = await this.inner.readRaw(real);
    if (typeof (result as { error?: unknown }).error === 'string') {
      return {
        ...result,
        error: this.toVirtual((result as { error: string }).error),
      };
    }
    return result;
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const real = this.toReal(filePath);
    if (!real) return { error: this.denyMsg(filePath) };
    return this.sanitize(await this.inner.write(real, content));
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const real = this.toReal(filePath);
    if (!real) return { error: this.denyMsg(filePath) };
    return this.sanitize(
      await this.inner.edit(real, oldString, newString, replaceAll),
    );
  }

  async glob(pattern: string, searchPath?: string): Promise<GlobResult> {
    // 缺省 searchPath 显式锚定工作区根（而非交给 inner 的默认 workdir）
    const real = this.toReal(searchPath ?? '/');
    if (!real) return { error: this.denyMsg(searchPath ?? '/') };
    return this.sanitize(await this.inner.glob(pattern, real));
  }

  async grep(
    pattern: string,
    searchPath?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    const real = this.toReal(searchPath ?? '/');
    if (!real) return { error: this.denyMsg(searchPath ?? '/') };
    return this.sanitize(
      await this.inner.grep(pattern, real, glob ?? undefined),
    );
  }

  // ─── execute（cwd 锚定 + 输出脱敏，无路径级硬隔离——见文件顶部说明）──────

  async execute(command: string): Promise<ExecuteResponse> {
    // 用单引号包围路径防空格，workspaceRoot 本身不含单引号（Daytona 路径约定）
    const result = await this.inner.execute(
      `cd '${this.workspaceRoot}' && ( ${command} )`,
    );
    // 输出里的真实工作区路径（pwd、报错栈等）替换回虚拟根，避免模型学到真实路径
    return this.sanitize(result);
  }

  // ─── getWorkDir 覆写——仅宿主侧使用（conversations 文件接口），返回真实路径 ─

  getWorkDir(): Promise<string> {
    return Promise.resolve(this.workspaceRoot);
  }

  // ─── host 侧方法：原样透传（可信宿主代码，技能同步/文件接口使用）────────

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
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
