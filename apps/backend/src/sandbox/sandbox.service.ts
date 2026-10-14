import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type DirEntry,
  type FilePreview,
  findUserSandbox,
  getSandboxProviderInfo,
  isSandboxConfigured,
  listDir,
  listWorkspaceFiles,
  pickUserSandbox,
  readFilePreview,
  readRawFile,
  type SandboxProviderName,
  startUserDesktop,
  stopUserDesktop,
} from '../agent/sandbox';
import { ErrorCodes } from '../common/errors/error-code';
import { BusinessException } from '../common/errors/business.exception';
import { assertSafeEntryPath } from '../skills/skill-installer';
import {
  contentDisposition,
  contentTypeFor,
  isInlineSafe,
  parseRange,
  RawFileCache,
} from './raw-file';
import { SandboxSettingsService } from './sandbox-settings.service';

/** GET /sandbox/file/raw 的响应：状态码 + 头 + 字节（controller 原样写回）。 */
export interface RawFileResponse {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** GET /sandbox/status 的响应形状（exists=false 时其余字段缺省）。 */
export interface SandboxStatus {
  exists: boolean;
  /** 沙箱提供方（SANDBOX_PROVIDER 配置） */
  provider?: SandboxProviderName;
  /** 当前提供方是否支持图形桌面（E2B 不支持）——前端据此禁用桌面入口 */
  desktopSupported?: boolean;
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
 * 状态、时间戳、auto-stop/delete 配置全部来自提供方 list() 结果
 * （Daytona: @daytonaio/api-client sandbox.d.ts:157/169/193；E2B: Sandbox.list，
 * 已实测不续期），不 connect、不 start。
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
  private readonly rawCache = new RawFileCache();

  constructor(private readonly settings: SandboxSettingsService) {}

  async status(userId: string, includeFiles = false): Promise<SandboxStatus> {
    // 用户在 /settings/sandbox 的设置（提供方未选/未配置 → env 默认）
    const config = await this.settings.resolve(userId);
    const { provider } = config;
    if (!isSandboxConfigured(provider)) return { exists: false };

    try {
      // 与 worker（getUserSandbox）共用同一确定性选择：状态面板与文件写入看同一个沙箱
      const sb = await pickUserSandbox(userId, provider);
      if (!sb) return { exists: false };

      const base: SandboxStatus = {
        exists: true,
        ...getSandboxProviderInfo(provider),
        id: sb.id,
        state: sb.state ?? 'unknown',
        createdAt: sb.createdAt ?? null,
        updatedAt: sb.updatedAt ?? null,
        // E2B 的 list 结果不含闲置时长，回退用户设置（Daytona 取远端实际值）
        autoStopMinutes: sb.autoStopInterval ?? config.lifecycle.idleMinutes,
        autoDeleteMinutes: sb.autoDeleteInterval ?? null,
        files: null,
      };

      if (includeFiles && sb.state === 'started') {
        // 文件列举失败不影响状态主体（如沙箱刚好在停机过渡态）
        try {
          const guarded = await findUserSandbox(userId, config);
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
    const sb = await findUserSandbox(
      userId,
      await this.settings.resolve(userId),
    );
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
    const sb = await findUserSandbox(
      userId,
      await this.settings.resolve(userId),
    );
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return readFilePreview(sb, filePath);
  }

  /**
   * 原始字节读取（视频/音频播放、下载）。支持单段 Range（206），<video> 才能拖动进度条。
   *
   * 缓存策略：只有「续传」类请求（Range 起点 > 0）读缓存；首次打开/从头播放/下载一律
   * 回源沙箱并刷新缓存——避免 agent 改写文件后预览拿到旧内容。
   * 安全：仅媒体类型允许 inline，其余强制 attachment，并附 nosniff + CSP sandbox
   * （同源反代自动带登录态，内联 HTML/SVG 会成为 XSS 入口，见 isInlineSafe）。
   */
  async readRaw(
    userId: string,
    filePath: string,
    rangeHeader: string | undefined,
    download: boolean,
  ): Promise<RawFileResponse> {
    this.assertSafePath(filePath);
    const config = await this.settings.resolve(userId);
    const cacheKey = `${userId}:${config.provider}:${filePath}`;
    const isContinuation = /^bytes=[1-9]/.test(rangeHeader?.trim() ?? '');

    let data = isContinuation ? this.rawCache.get(cacheKey) : undefined;
    if (!data) {
      const sb = await findUserSandbox(userId, config);
      if (!sb) {
        throw new BusinessException(
          ErrorCodes.SANDBOX_NOT_FOUND,
          HttpStatus.NOT_FOUND,
        );
      }
      try {
        data = await readRawFile(sb, filePath);
      } catch {
        throw new BusinessException(
          ErrorCodes.SANDBOX_NOT_FOUND,
          HttpStatus.NOT_FOUND,
        );
      }
      this.rawCache.set(cacheKey, data);
    }

    const contentType = contentTypeFor(filePath);
    const disposition =
      !download && isInlineSafe(contentType) ? 'inline' : 'attachment';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(filePath, disposition),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'private, no-store',
    };

    const size = data.length;
    const range = parseRange(rangeHeader, size);
    if (range === 'unsatisfiable') {
      return {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
        body: new Uint8Array(0),
      };
    }
    if (range) {
      return {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        },
        body: data.subarray(range.start, range.end + 1),
      };
    }
    return { status: 200, headers, body: data };
  }

  /**
   * 启动图形桌面并返回 noVNC 地址（POST /sandbox/desktop）。
   * 沙箱不存在或未运行 → SANDBOX_NOT_RUNNING（前端按钮已按 state 禁用，双保险）。
   */
  async startDesktop(userId: string): Promise<{ url: string }> {
    const url = await startUserDesktop(
      userId,
      (await this.settings.resolve(userId)).provider,
    );
    if (!url) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_RUNNING,
        HttpStatus.CONFLICT,
      );
    }
    return { url };
  }

  /** 停止图形桌面（DELETE /sandbox/desktop，Dialog 关闭时收尾语义，永不抛错）。 */
  async stopDesktop(userId: string): Promise<void> {
    await stopUserDesktop(
      userId,
      (await this.settings.resolve(userId)).provider,
    );
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
