import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type DirEntry,
  type FilePreview,
  findUserSandbox,
  listDir,
  listWorkspaceFiles,
  pickUserSandbox,
  readFilePreview,
} from '../agent/sandbox';
import { ErrorCodes } from '../common/errors/error-code';
import { BusinessException } from '../common/errors/business.exception';
import { assertSafeEntryPath } from '../skills/skill-installer';

/** GET /sandbox/status 的响应形状（exists=false 时其余字段缺省）。 */
export interface SandboxStatus {
  exists: boolean;
  id?: string;
  state?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** 闲置自动停机间隔（分钟，0=禁用）——前端展示配置说明用 */
  autoStopMinutes?: number | null;
  /** 停机后自动删除间隔（分钟，负=禁用）——前端据 updatedAt 计算删除倒计时 */
  autoDeleteMinutes?: number | null;
  /** 工作区产物文件（仅 started 时返回；停机态为 null，不唤醒沙箱） */
  files?: { path: string }[] | null;
}

/**
 * 沙箱状态查询（user 级只读）。
 *
 * 与 getUserSandbox/findUserSandbox 的关键区别：**绝不唤醒停机沙箱**——
 * 状态、时间戳、auto-stop/delete 配置全部来自 Daytona list() 的 DTO
 * （@daytonaio/api-client sandbox.d.ts:157/169/193），不 fromId、不 start。
 *
 * includeFiles 默认 false（心跳轮询专用）：**默认路径只调 list()**。
 * 实测（2026-06-11 对照实验）：GET /sandbox/:id（fromId 内部调用）会刷新
 * lastActivityAt（服务端 ~60s 节流），15s 心跳若每次都 fromId+exec 列文件，
 * 沙箱闲置计时永远凑不满 autoStop（5min）→ 永不自动停机/回收；list() 则不产生
 * 活动事件。文件列表只在详情面板打开（?files=1）且 state=started 时拉取——
 * 此时用户正在查看，续命副作用可接受。
 */
@Injectable()
export class SandboxStatusService {
  private readonly logger = new Logger(SandboxStatusService.name);

  async status(userId: string, includeFiles = false): Promise<SandboxStatus> {
    if (!process.env.DAYTONA_API_KEY) return { exists: false };

    try {
      // 与 worker（getUserSandbox）共用同一确定性选择：状态面板与文件写入看同一个沙箱
      const sb = await pickUserSandbox(userId);
      if (!sb) return { exists: false };

      const base: SandboxStatus = {
        exists: true,
        id: sb.id,
        state: sb.state ?? 'unknown',
        createdAt: sb.createdAt ?? null,
        updatedAt: sb.updatedAt ?? null,
        autoStopMinutes: sb.autoStopInterval ?? null,
        autoDeleteMinutes: sb.autoDeleteInterval ?? null,
        files: null,
      };

      if (includeFiles && sb.state === 'started') {
        // 文件列举失败不影响状态主体（如沙箱刚好在停机过渡态）
        try {
          const guarded = await findUserSandbox(userId);
          if (guarded) base.files = await listWorkspaceFiles(guarded);
        } catch (e) {
          this.logger.warn(`沙箱文件列举失败 userId=${userId}: ${String(e)}`);
        }
      }
      return base;
    } catch (e) {
      // 沙箱是可降级能力：查询异常按「无沙箱」返回，不向前端报错
      this.logger.warn(`沙箱状态查询失败 userId=${userId}: ${String(e)}`);
      return { exists: false };
    }
  }

  /**
   * 列出工作区某目录的直接子项（树展开时按需调用）。
   * dir 为相对虚拟路径（''=根），经 assertSafeEntryPath 拒绝 .. / 绝对路径。
   * 与 status 不同：这里会 findUserSandbox（停机则唤醒）——用户正在浏览，续命副作用可接受。
   */
  async listDir(userId: string, dir: string): Promise<{ entries: DirEntry[] }> {
    if (dir) this.assertSafePath(dir);
    const sb = await findUserSandbox(userId);
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return { entries: await listDir(sb, dir) };
  }

  /** 读取单个文件用于预览（点击文件时按需调用）。文本/图片/二进制三态见 readFilePreview。 */
  async readFile(userId: string, filePath: string): Promise<FilePreview> {
    this.assertSafePath(filePath);
    const sb = await findUserSandbox(userId);
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return readFilePreview(sb, filePath);
  }

  /**
   * 路径安全校验：复用 skill-installer 的纯函数（拒 .. 片段与绝对路径），
   * 把其 skill 语义错误转成更清晰的 INVALID_PATH（与 conversations 文件接口口径一致）。
   */
  private assertSafePath(relPath: string): void {
    try {
      assertSafeEntryPath(relPath);
    } catch {
      throw new BusinessException(
        ErrorCodes.INVALID_PATH,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
