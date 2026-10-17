import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { assertSafeEntryPath } from '../skills/skill-installer';
import { CreateFilePreviewDto } from './dto/create-file-preview.dto';
import { CreatePortPreviewDto } from './dto/create-port-preview.dto';
import { previewOrigin } from './preview-host';
import { isPreviewablePort } from './preview-ports';
import { PreviewSessionService } from './preview-session.service';

/** 会话 id：128 位随机数的 hex（与 preview-host 的子域名约定一致）。 */
const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const notFound = () =>
  new BusinessException(ErrorCodes.PREVIEW_NOT_FOUND, HttpStatus.NOT_FOUND);

@Controller('preview')
@UseGuards(JwtAuthGuard)
export class PreviewController {
  constructor(private readonly sessions: PreviewSessionService) {}

  /**
   * 为用户沙箱的某个端口签发预览地址 `p-<id>.<基域名><path>`（反代见 PreviewProxy）。
   * 签发时就解析一次上游：沙箱没在运行立刻报错，而不是让用户对着一个 404 的 iframe。
   */
  @Post('port')
  async createPort(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePortPreviewDto,
  ): Promise<{ id: string; url: string }> {
    if (!isPreviewablePort(dto.port)) {
      throw new BusinessException(
        ErrorCodes.PREVIEW_PORT_NOT_ALLOWED,
        HttpStatus.BAD_REQUEST,
      );
    }
    const id = await this.sessions.createPort(user.userId, dto.port);
    if (!(await this.sessions.upstream(id))) {
      throw new BusinessException(
        ErrorCodes.PREVIEW_SANDBOX_NOT_RUNNING,
        HttpStatus.CONFLICT,
      );
    }
    return { id, url: `${previewOrigin(id)}${dto.path ?? '/'}` };
  }

  /**
   * 为工作区里的 HTML 入口签发静态网页预览地址 `p-<id>.<基域名>/<入口文件名>`。
   * 站点根 = 入口所在目录：页面里 `./app.js`、`css/x.css` 这类相对引用落在同一站点下；
   * 访问范围也只到这个目录（agent 写的页面若被注入恶意脚本，读不到工作区其它产物）。
   * 不在这里检查文件是否存在——那要唤醒沙箱，加载时不存在自然 404。
   */
  @Post('file')
  async createFile(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFilePreviewDto,
  ): Promise<{ id: string; url: string }> {
    const rel = dto.path.replace(/^\/+/, '');
    try {
      assertSafeEntryPath(rel);
    } catch {
      throw new BusinessException(
        ErrorCodes.INVALID_PATH,
        HttpStatus.BAD_REQUEST,
      );
    }
    const i = rel.lastIndexOf('/');
    const root = i === -1 ? '' : rel.slice(0, i);
    const file = rel.slice(i + 1);
    const id = await this.sessions.createFile(user.userId, root);
    return { id, url: `${previewOrigin(id)}/${encodeURIComponent(file)}` };
  }

  /** 重置预览：撤销自己的会话，地址立即失效（下次打开拿到新地址、新的源）。 */
  @Delete(':id')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ revoked: true }> {
    if (
      !SESSION_ID_RE.test(id) ||
      !(await this.sessions.revoke(id, user.userId))
    ) {
      throw notFound();
    }
    return { revoked: true };
  }

  /**
   * 预览弹窗心跳（打开期间每分钟一次）：让沙箱保持活跃。纯前端应用里点来点去可能
   * 一个请求都不发，只靠反代流量续期不够——弹窗开着就算在用。
   */
  @Post(':id/keepalive')
  @HttpCode(HttpStatus.OK)
  async keepAlive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const session = SESSION_ID_RE.test(id) ? await this.sessions.get(id) : null;
    if (!session || session.u !== user.userId) throw notFound();
    await this.sessions.keepAlive(user.userId);
    return { ok: true };
  }
}
