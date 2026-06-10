import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';

export type MediaType = 'image' | 'video';

/**
 * 资产根目录（懒读 env）：默认 <cwd>/data/media。
 * 为什么懒读而非模块加载期读：与 google client 一致，避免加载即依赖 env，且测试可临时覆盖。
 */
export function mediaDataDir(): string {
  return process.env.MEDIA_DATA_DIR ?? join(process.cwd(), 'data', 'media');
}

/**
 * 媒体生成业务层：建生成位/版本、重新生成、列历史、取资产路径。
 * 不直接触碰 @google/genai（那是 processor 经 GoogleMediaClient 干的事）；本层只管 DB + 入队 + 推流。
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    @InjectQueue('media-gen') private readonly queue: Queue,
  ) {}

  /**
   * 创建一个生成位 + 首个 queued 版本，入队后推一条 media_update(queued)。
   * 经 tool 调用时 userId 由 worker 传入（已可信，不再二次校验会话归属）。
   * 返回 { generationId, versionId } 供工具回传给前端做锚点。
   */
  async createGeneration(
    conversationId: string,
    userId: string,
    type: MediaType,
    prompt: string,
  ): Promise<{ generationId: string; versionId: string }> {
    const model =
      type === 'image'
        ? process.env.MEDIA_IMAGE_MODEL ?? 'gemini-3.1-flash-image-preview'
        : process.env.MEDIA_VIDEO_MODEL ?? 'veo-3.1-generate-preview';

    const generation = await this.prisma.mediaGeneration.create({
      data: {
        conversationId,
        userId,
        type,
        versions: { create: { prompt, model, status: 'queued' } },
      },
      include: { versions: true },
    });
    const version = generation.versions[0];

    await this.queue.add('generate', { versionId: version.id });
    // 入队后推流：前端据此 invalidate media query（设计 §前端职责）。仅状态变更推流。
    await this.publishUpdate(conversationId, generation.id, version.id, type, 'queued');

    return { generationId: generation.id, versionId: version.id };
  }

  /**
   * 重新生成：在同一 generation 下叠新版本（旧版本行与资产文件不动，历史可回看）。
   * prompt 缺省时沿用上一版（仅服务 API 直调；前端总是回传当前值）。
   * 校验归属：generation.userId === 调用者 userId。
   */
  async regenerate(
    generationId: string,
    userId: string,
    prompt?: string,
  ): Promise<{ generationId: string; versionId: string }> {
    const generation = await this.prisma.mediaGeneration.findUnique({
      where: { id: generationId },
      include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!generation || generation.userId !== userId) {
      throw new BusinessException(
        ErrorCodes.MEDIA_GENERATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const last = generation.versions[0];
    // prompt 缺省沿用上一版；无上一版（理论不该发生）则报错而非建空 prompt 版本
    const finalPrompt = prompt ?? last?.prompt;
    if (!finalPrompt) {
      throw new BusinessException(
        ErrorCodes.MEDIA_VERSION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    // model 沿用上一版（同 generation 同类型，模型不变）；无上一版时回退 env
    const model =
      last?.model ??
      (generation.type === 'image'
        ? process.env.MEDIA_IMAGE_MODEL ?? 'gemini-3.1-flash-image-preview'
        : process.env.MEDIA_VIDEO_MODEL ?? 'veo-3.1-generate-preview');

    const version = await this.prisma.mediaVersion.create({
      data: { generationId, prompt: finalPrompt, model, status: 'queued' },
    });

    await this.queue.add('generate', { versionId: version.id });
    await this.publishUpdate(
      generation.conversationId,
      generationId,
      version.id,
      generation.type as MediaType,
      'queued',
    );

    return { generationId, versionId: version.id };
  }

  /**
   * 列出会话下全部生成位（含全部版本，均按 createdAt desc）。
   * 归属校验：仅返回该 userId 的生成位（多租户隔离经 userId 关联）。
   */
  async listForConversation(conversationId: string, userId: string) {
    return this.prisma.mediaGeneration.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { createdAt: 'desc' } } },
    });
  }

  /**
   * 取某版本资产的绝对路径 + MIME（供 controller 流式下载）。
   * 校验归属：version → generation.userId === userId。未完成（无 filePath）则报 NOT_READY。
   */
  async getVersionAsset(
    versionId: string,
    userId: string,
  ): Promise<{ absPath: string; mimeType: string }> {
    const version = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    if (!version || version.generation.userId !== userId) {
      throw new BusinessException(
        ErrorCodes.MEDIA_VERSION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (version.status !== 'done' || !version.filePath) {
      throw new BusinessException(
        ErrorCodes.MEDIA_ASSET_NOT_READY,
        HttpStatus.CONFLICT,
      );
    }
    return {
      absPath: join(mediaDataDir(), version.filePath),
      mimeType: mimeForFilePath(version.filePath),
    };
  }

  /** 统一推一条 media_update（仅状态变更时调用）。 */
  private async publishUpdate(
    conversationId: string,
    generationId: string,
    versionId: string,
    type: MediaType,
    status: string,
    error?: string,
  ): Promise<void> {
    await this.stream.publish(conversationId, {
      type: 'media_update',
      payload: { generationId, versionId, type, status, error },
    });
  }
}

/** 由文件后缀推 Content-Type（资产文件名 = <versionId>.<ext>）。 */
function mimeForFilePath(filePath: string): string {
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}
