import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';
import { RegenerateMediaDto } from './dto/regenerate-media.dto';

/**
 * 媒体接口。
 *
 * 路由设计：class-level 留空 @Controller()，逐路由写全 path，使 `GET /conversations/:id/media`
 * 的 URL 与设计一致、又不必改 conversations 模块（高内聚收口在 media 目录，设计已决议）。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** 列出会话下全部生成位（含全部版本，desc）。 */
  @Get('conversations/:id/media')
  list(@Param('id') conversationId: string, @CurrentUser() user: AuthUser) {
    return this.media.listForConversation(conversationId, user.userId);
  }

  /** 重新生成：同 generation 叠新版本（旧版保留）。prompt 缺省沿用上一版。 */
  @Post('media/generations/:id/regenerate')
  regenerate(
    @Param('id') generationId: string,
    @Body() dto: RegenerateMediaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.media.regenerate(generationId, user.userId, dto.prompt);
  }

  /**
   * 二进制流式下载某版本资产。
   * 归属校验后用 StreamableFile 原样响应——ResponseInterceptor 已对 StreamableFile 透传，
   * 不裹 JSON envelope（设计 Issue 10）；前端 fetch+Authorization → blob URL。
   */
  @Get('media/versions/:id/asset')
  async asset(
    @Param('id') versionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    const { absPath, mimeType } = await this.media.getVersionAsset(
      versionId,
      user.userId,
    );
    return new StreamableFile(createReadStream(absPath), { type: mimeType });
  }
}
