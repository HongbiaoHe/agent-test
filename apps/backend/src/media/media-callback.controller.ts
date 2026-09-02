import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { aigcTaskSchema } from '../aigc/aigc.types';
import { PrismaService } from '../prisma/prisma.service';
import { verifyAssetToken } from './media-asset-token';
import { mediaDataDir, MediaService, mimeForFilePath } from './media.service';
import { join } from 'node:path';

/**
 * aigc 用的两条**无 JWT 鉴权**路由（故与 MediaController 分开：那个类挂着 JwtAuthGuard）。
 *
 *  - `POST /media/aigc/callback`：任务终态通知。凭据是 aigc 回传的 Bearer（= 我方给它的
 *    project token，文档 §9.1），与本地配置比对通过才受理。
 *  - `GET  /media/public/assets/:file`：参考图的公网下载口。凭据是 URL 上的签名
 *    （见 media-asset-token.ts）——aigc 拿不到用户 token，但生成图生图/首帧时必须能下到这张图。
 *
 * 两条都不返回任何用户数据：回调只吃 task 结果，资产口只按签名放行单个已完成版本。
 */
@Controller('media')
export class MediaCallbackController {
  constructor(
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('aigc/callback')
  async callback(
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    assertAigcToken(auth);
    // 回调 body 与查询响应同构：{ code, message, data }（文档 §9.2）。
    // 用 zod 剥信封而不是断言：外部数据在边界上解析成强类型（CLAUDE.md §8）。
    const envelope = callbackEnvelopeSchema.safeParse(body);
    const parsed = aigcTaskSchema.safeParse(
      envelope.success && envelope.data.data !== undefined
        ? envelope.data.data
        : body,
    );
    if (!parsed.success) {
      throw new BadRequestException('unrecognized aigc callback body');
    }
    // 尽快应答（文档 §9.3）：落库 + 转存产物都很短，直接同步做完再回 2xx，
    // 这样重复投递能被状态条件挡掉；真失败时 aigc 会重投，我方另有对账轮询兜底。
    await this.media.applyTaskResult(parsed.data);
    return { received: true };
  }

  /**
   * 签名放行的资产下载。`file` 即落盘文件名 `<versionId>.<ext>`——带真后缀，
   * 免得上游按扩展名判类型时认不出。
   */
  @Get('public/assets/:file')
  async publicAsset(
    @Param('file') file: string,
    @Query('token') token: string | undefined,
  ): Promise<StreamableFile> {
    const versionId = file.split('.')[0];
    if (!versionId || !token || !verifyAssetToken(versionId, token)) {
      throw new ForbiddenException('invalid asset token');
    }
    const version = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      select: { status: true, filePath: true },
    });
    // filePath 必须与请求的文件名一致：签名只绑 versionId，别让人拿它拼出别的路径
    if (!version || version.status !== 'done' || version.filePath !== file) {
      throw new NotFoundException('asset not available');
    }
    return new StreamableFile(
      createReadStream(join(mediaDataDir(), version.filePath)),
      { type: mimeForFilePath(version.filePath) },
    );
  }
}

/** 回调信封（§9.2）：只需要把 data 剥出来，其余字段交给 zod 剥掉。 */
const callbackEnvelopeSchema = z.object({ data: z.unknown().optional() });

/** 回调鉴权：Bearer 必须等于我方配给 aigc 的 project token（Bearer 大小写不敏感）。 */
function assertAigcToken(auth: string | undefined): void {
  const expected = process.env.AIGC_TOKEN;
  if (!expected) throw new ForbiddenException('aigc token not configured');
  const got = auth?.replace(/^bearer\s+/i, '').trim() ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ForbiddenException('invalid aigc callback token');
  }
}
