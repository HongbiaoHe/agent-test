import { Injectable, Logger } from '@nestjs/common';
import {
  findUserSandbox,
  listWorkspaceFiles,
  pickUserSandbox,
} from '../agent/sandbox';

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
 * 仅当 state=started 时才连上去列工作区文件（此时本就在运行，无唤醒副作用）。
 */
@Injectable()
export class SandboxStatusService {
  private readonly logger = new Logger(SandboxStatusService.name);

  async status(userId: string): Promise<SandboxStatus> {
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

      if (sb.state === 'started') {
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
}
