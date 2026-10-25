import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { createReadStream } from 'node:fs';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { cleanFilename, MediaUploadService } from './media-upload.service';
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
  constructor(
    private readonly media: MediaService,
    private readonly uploads: MediaUploadService,
  ) {}

  /** 列出会话下全部生成位（含全部版本，desc）。 */
  @Get('conversations/:id/media')
  list(@Param('id') conversationId: string, @CurrentUser() user: AuthUser) {
    return this.media.listForConversation(conversationId, user.userId);
  }

  /**
   * 上传一个附件文件：请求体就是文件二进制（不是 multipart），Content-Type / Content-Length
   * 即文件类型与字节数，原始文件名走 query。后端流式中转到 GCS，返回暂存（staged）的资产，
   * 随下一条消息的 attachmentVersionIds 发出时才转正。
   * 非 JSON 的 Content-Type 不会被全局 body parser 消费，req 仍是完整的原始流。
   */
  @Post('conversations/:id/uploads')
  upload(
    @Param('id') conversationId: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Query('filename') filename: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    return this.uploads.upload({
      conversationId,
      tenantId: user.tenantId,
      userId: user.userId,
      // 去掉 `; charset=...` 之类的参数，白名单按纯 MIME 比对
      contentType: (contentType ?? '').split(';')[0].trim().toLowerCase(),
      size: Number(contentLength),
      filename: cleanFilename(filename),
      body: req,
    });
  }

  /** 重新生成：同 generation 叠新版本（旧版保留）。prompt 缺省沿用上一版。 */
  @Post('media/generations/:id/regenerate')
  regenerate(
    @Param('id') generationId: string,
    @Body() dto: RegenerateMediaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.media.regenerate(
      generationId,
      user.userId,
      dto.prompt,
      dto.referenceVersionIds,
    );
  }

  /**
   * 某版本资产的来源：`{ url }` 为 aigc 产物的 CDN 地址；为 null 时改走下面的 asset 接口取本地文件。
   */
  @Get('media/versions/:id/source')
  source(@Param('id') versionId: string, @CurrentUser() user: AuthUser) {
    return this.media.getVersionSource(versionId, user.userId);
  }

  /**
   * 二进制流式下载某版本的本地资产（拼接产物 / 未回填 url 的历史版本）。
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
