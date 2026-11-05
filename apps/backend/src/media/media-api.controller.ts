import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  MediaApiCloneVoiceDto,
  MediaApiGenerateDto,
  MediaApiModelsQuery,
  MediaApiScopeQuery,
  MediaApiSourcesDto,
} from './dto/media-api.dto';
import { cleanFilename, MediaUploadService } from './media-upload.service';
import { MediaService } from './media.service';

/** desktop 会话在后端的记账 id：与 Spark 会话（cuid）、画布会话互不冲突 */
export function desktopScope(scope: string): string {
  return `desktop:${scope}`;
}

/**
 * Spark 桌面端的媒体接口：桌面端登录 Web 账号后，agent 的生图 / 生视频 / 配音 / 克隆音色经这里调到
 * **同一个 MediaService**（工具定义两端共用 agent-core media-tools）。桌面端的会话只在本机，
 * 生成记录按 `desktop:<本机会话 id>` 记账（MediaGeneration.conversationId 不是外键，归属一律按 userId 校验）。
 * 状态没有推流（桌面端不连 socket），由桌面端轮询 GET /media-api/generations。
 * 重新生成、取 CDN 地址复用 MediaController 的 /media/generations/:id/regenerate、/media/versions/:id/source。
 */
@Controller('media-api')
@UseGuards(JwtAuthGuard)
export class MediaApiController {
  constructor(
    private readonly media: MediaService,
    private readonly uploads: MediaUploadService,
  ) {}

  /** 同 list_media_models 工具 */
  @Get('models')
  models(@Query() q: MediaApiModelsQuery, @CurrentUser() user: AuthUser) {
    return this.media.agentModelCatalog(q.type, user.userId);
  }

  /** 同 generate_image / generate_video / generate_audio：校验不过返回 { ok:false, issues } */
  @Post('generations')
  generate(@Body() dto: MediaApiGenerateDto, @CurrentUser() user: AuthUser) {
    return this.media.createAgentGenerations(
      desktopScope(dto.scope),
      user.userId,
      dto.type,
      {
        prompt: dto.prompt,
        model: dto.model,
        channel: dto.channel,
        params: dto.params,
        referenceVersionIds: dto.referenceVersionIds,
        count: dto.count,
      },
    );
  }

  /** 同 clone_voice */
  @Post('voices')
  cloneVoice(
    @Body() dto: MediaApiCloneVoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.media.createVoiceClone(desktopScope(dto.scope), user.userId, {
      sourceVersionId: dto.sourceVersionId,
      language: dto.language,
      demoText: dto.demoText,
    });
  }

  /**
   * 同 sync_media_to_sandbox 的取源：本会话（用户附件 / 生成产物）的 CDN 地址与文件名，
   * 桌面端据此下载进本机工作区（只返回本会话、本人的版本；不合法的进 errors）。
   */
  @Post('sources')
  sources(@Body() dto: MediaApiSourcesDto, @CurrentUser() user: AuthUser) {
    return this.media.resolveSandboxSources(
      desktopScope(dto.scope),
      user.userId,
      [...new Set(dto.versionIds)],
    );
  }

  /** 某个桌面会话下的全部生成位（形状同 GET /conversations/:id/media），卡片据此轮询状态 */
  @Get('generations')
  list(@Query() q: MediaApiScopeQuery, @CurrentUser() user: AuthUser) {
    return this.media.listForConversation(desktopScope(q.scope), user.userId);
  }

  /**
   * 上传参考素材（用户附件里的图片 / 视频 / 音频）：请求体就是文件二进制，同 POST /conversations/:id/uploads，
   * 但直接落 done——桌面端在发送时才上传，传完即可被 referenceVersionIds 引用。
   */
  @Post('uploads')
  upload(
    @Query() q: MediaApiScopeQuery,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Query('filename') filename: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    return this.uploads.store({
      conversationId: desktopScope(q.scope),
      userId: user.userId,
      contentType: (contentType ?? '').split(';')[0].trim().toLowerCase(),
      size: Number(contentLength),
      filename: cleanFilename(filename),
      body: req,
      status: 'done',
    });
  }
}
