/**
 * GuardedSandbox — agent 专用目录守卫 + 统一的工作区路径（官方 §9.5 policy hook 模式）。
 *
 * 包装一个 DaytonaSandbox / E2BSandbox（任意 GuardableSandbox 实现）。工作区真实目录是
 * workspaceRoot（如 /home/daytona/agent-workspace），agent 看到的是 **visibleRoot**：
 * 正常为 `/workspace`——openWorkspace 在沙箱里建了 `/workspace → workspaceRoot` 软链，
 * 所以这条路径在**文件工具与 shell 里含义完全一致**；建软链失败（无 sudo / 已被占用）时
 * visibleRoot 退回真实路径本身，同样一致。
 *
 * 为什么不再把工作区伪装成 `/`：伪装只对文件工具成立。shell 里的 `/` 是容器根目录，于是
 * 模型看到 `pwd` 输出 `/`（被脱敏）后，`mkdir -p /app` 会因权限失败、再 sudo 写进容器根；
 * write_file('/app/x') 却落在工作区——同一个 `/app` 两边各有一份。`/skills/...` 在 shell 里
 * 根本不存在，技能脚本按提示执行必然失败（2026-10-17 实测）。
 *
 *  - 入站（agent → 沙箱）：文件方法的路径——
 *      `${visibleRoot}/foo`        → `${workspaceRoot}/foo`
 *      相对 `foo`                  → `${workspaceRoot}/foo`（与 execute 的 cwd 一致）
 *      `/` 或 ''                   → 工作区根（ls/glob/grep 的缺省值）
 *      真实工作区路径               → 原样接受（宿主侧、`pwd -P` 等）
 *      其它绝对路径 / `../` 逃逸     → 返回 error 形状（不 throw），提示正确的路径写法
 *  - 出站（沙箱 → agent）：结果里的真实 workspaceRoot 前缀替换为 visibleRoot
 *      （ls/glob/grep 路径、write/edit 回显、execute 输出），模型只见到一种写法。
 *
 * ⚠️  execute 的安全边界说明：
 *   路径守卫只作用于文件工具（ls/read/readRaw/write/edit/glob/grep）。
 *   execute 仅做 cwd 锚定 + 输出改写——绝对路径仍可访问工作区外（如 `cat /etc/passwd`）。
 *   真正的隔离边界是沙箱本身（Daytona / E2B 用户级沙箱）；本守卫的目标是：
 *     1) 文件工具层面的硬限制（agent 调 write_file/read_file 无法出域）；
 *     2) execute 工作目录锚定在 visibleRoot（相对路径与文件工具一致）；
 *     3) 真实路径不进入模型上下文。
 *
 * isSandboxProtocol duck-typing 检测：execute 是 function、id 是非空 string。
 * GuardedSandbox 满足两者（委托 inner.execute，id getter 委托 inner.id）。
 *
 * getWorkDir() 覆写为直接返回 workspaceRoot（真实路径）——它只被宿主侧代码使用
 * （conversations 文件接口的 listFiles/downloadFile），不进入模型上下文。
 *
 * uploadFiles / downloadFiles 与文件工具同样走 toReal：技能库注入 `${skillsDir}/<name>/...`
 * 落到 `${workspaceRoot}/skills/...`，deepagents 的 skills 中间件（ls + downloadFiles 扫
 * skillsDir）才能读到；conversations 文件接口传真实路径或相对路径，均被接受。
 *
 * 技能库（`${workspaceRoot}/skills/`）只读：write/edit 命中直接拒绝，防 agent 改坏注入的技能文件
 * （每轮 run 前会重新上传，但运行中不应被污染）。
 *
 * start / isRunning / id 等 host 侧方法原样透传。
 */

import path from 'node:path';
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
import type { GuardableSandbox } from './sandbox-providers';

export class GuardedSandbox {
  /** 满足 isSandboxProtocol duck-typing：id 委托给 inner */
  get id(): string {
    return this.inner.id;
  }

  /** isRunning 透传（caller 做 isRunning 检查） */
  get isRunning(): boolean {
    return this.inner.isRunning;
  }

  constructor(
    private readonly inner: GuardableSandbox,
    readonly workspaceRoot: string,
    /** agent 眼中的工作区路径（`/workspace` 软链；缺省 = 真实路径），见文件头 */
    readonly visibleRoot: string = workspaceRoot,
  ) {}

  /** agent 眼中的技能库目录（deepagents skills 中间件扫描、SKILL.md 引用改写都用它）。 */
  get skillsDir(): string {
    return `${this.visibleRoot}/skills`;
  }

  /**
   * agent 给的路径 → 工作区相对路径（'' = 根）；不在工作区内 → null。
   * 给需要相对路径的宿主接口用（如网页预览按工作区相对路径签发地址）。
   */
  toWorkspaceRelative(p: string): string | null {
    const real = this.toReal(p);
    if (real === null) return null;
    return real === this.workspaceRoot
      ? ''
      : real.slice(this.workspaceRoot.length + 1);
  }

  // ─── 虚拟根映射 ───────────────────────────────────────────────────────────

  /** p 是否等于 root 或位于其下。 */
  private static within(p: string, root: string): boolean {
    return p === root || p.startsWith(root + '/');
  }

  /**
   * 入站：agent 的路径 → 工作区内真实路径；不在工作区内 → null（规则见文件头）。
   * posix.resolve 规范化 `../`，防逃逸。
   */
  private toReal(p: string): string | null {
    let real: string;
    if (p === '' || p === '/') {
      real = this.workspaceRoot;
    } else if (GuardedSandbox.within(p, this.workspaceRoot)) {
      // 宿主侧传真实路径，或 agent 从 `pwd -P` 等处拿到真实路径：原样接受
      real = path.posix.resolve(p);
    } else if (GuardedSandbox.within(p, this.visibleRoot)) {
      real = path.posix.resolve(
        this.workspaceRoot,
        `.${p.slice(this.visibleRoot.length)}`,
      );
    } else if (p.startsWith('/')) {
      // 工作区外的绝对路径：文件工具不可达（shell 里它指向容器系统目录，两边不能混用）
      return null;
    } else {
      // 相对路径按工作区根解析，与 execute 的 cwd 一致
      real = path.posix.resolve(this.workspaceRoot, p);
    }
    if (
      real === this.workspaceRoot ||
      real.startsWith(this.workspaceRoot + '/')
    )
      return real;
    return null;
  }

  /** 真实路径是否落在只读技能库 `${workspaceRoot}/skills/` 下。 */
  private isSkillsPath(real: string): boolean {
    return GuardedSandbox.within(real, `${this.workspaceRoot}/skills`);
  }

  /** 出站：字符串里的真实工作区前缀替换为 visibleRoot（两者相同则不变）。 */
  private toVirtual(s: string): string {
    return s.replaceAll(this.workspaceRoot, this.visibleRoot);
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

  /** 拒绝消息：不暴露真实路径，给出正确写法（回显的入参路径同样改写）。 */
  private denyMsg(p: string): string {
    return (
      `路径不在工作区内：${this.toVirtual(p)}。文件工具只能访问 ${this.visibleRoot} 下的路径` +
      `（如 ${this.visibleRoot}/my-app/index.html，或相对路径 my-app/index.html）`
    );
  }

  /** 只读技能库拒写消息。 */
  private skillsReadOnlyMsg(p: string): string {
    return `${this.skillsDir}/ 是只读技能库，禁止写入：${this.toVirtual(p)}`;
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
    if (this.isSkillsPath(real))
      return { error: this.skillsReadOnlyMsg(filePath) };
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
    if (this.isSkillsPath(real))
      return { error: this.skillsReadOnlyMsg(filePath) };
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
    // cd 到 visibleRoot（/workspace 软链）：pwd 打印的就是文件工具认的那条路径。
    // 单引号包围防空格，路径本身不含单引号（Daytona / E2B home 路径约定）
    const result = await this.inner.execute(
      `cd '${this.visibleRoot}' && ( ${command} )`,
    );
    // 输出里残留的真实工作区路径（pwd -P、报错栈等）改写为 visibleRoot
    return this.sanitize(result);
  }

  // ─── getWorkDir 覆写——仅宿主侧使用（conversations 文件接口），返回真实路径 ─

  getWorkDir(): Promise<string> {
    return Promise.resolve(this.workspaceRoot);
  }

  // ─── host 侧批量传输：路径走 toReal 映射（虚拟根 → 工作区真实路径）─────────

  /**
   * 入站路径映射 + 逃逸拒绝：技能同步传 `${skillsDir}/...` → `${workspaceRoot}/skills/...`；
   * conversations 传真实工作区路径 → toReal 原样接受。逃逸到区外的项返回 error，保持数组对齐。
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = new Array<FileUploadResponse>(
      files.length,
    );
    const allowed: Array<[string, Uint8Array]> = [];
    const allowedIdx: number[] = [];
    files.forEach(([p, content], i) => {
      const real = this.toReal(p);
      // error 是标准化错误码（非自由文本）：逃逸工作区按 invalid_path
      if (real === null)
        results[i] = { path: this.toVirtual(p), error: 'invalid_path' };
      else {
        allowed.push([real, content]);
        allowedIdx.push(i);
      }
    });
    if (allowed.length > 0) {
      const res = this.sanitize(await this.inner.uploadFiles(allowed));
      res.forEach((r, j) => (results[allowedIdx[j]] = r));
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = new Array<FileDownloadResponse>(
      paths.length,
    );
    const allowed: string[] = [];
    const allowedIdx: number[] = [];
    paths.forEach((p, i) => {
      const real = this.toReal(p);
      // error 是标准化错误码（非自由文本）：逃逸工作区按 invalid_path
      if (real === null)
        results[i] = {
          path: this.toVirtual(p),
          content: null,
          error: 'invalid_path',
        };
      else {
        allowed.push(real);
        allowedIdx.push(i);
      }
    });
    if (allowed.length > 0) {
      const res = await this.inner.downloadFiles(allowed);
      // content 可能是二进制，不脱敏；error 是错误码不脱敏；仅 path 按虚拟根脱敏
      res.forEach((r, j) => {
        results[allowedIdx[j]] = { ...r, path: this.toVirtual(r.path) };
      });
    }
    return results;
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

  /** 轮内心跳透传；提供方不需要（Daytona）即 no-op。 */
  async heartbeat(): Promise<void> {
    await this.inner.heartbeat?.();
  }
}
