import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { GoogleMediaClient } from './google-media.client';
import { mediaDataDir, MediaType } from './media.service';

interface MediaJobData {
  versionId: string;
}

/**
 * 由 MIME 推资产文件后缀（纯函数，便于单测）。
 * jpeg→jpg、png→png、其余图像兜底 png；视频统一 mp4。
 */
export function decideExt(mimeType: string): string {
  if (mimeType.startsWith('video/')) return 'mp4';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  // 其余未知图像类型兜底 png（generateContent 图像分支才会走到这）
  return 'png';
}

/**
 * 媒体生成 worker：消费 media-gen 队列的 { versionId }。
 * 流程：load version+generation → generating(推流) → 调 google client → 落盘 → done/failed(推流)。
 * 只在状态变更时推流（generating / done|failed），轮询 tick 不推（避免前端失效风暴，设计 Issue 9）。
 */
@Processor('media-gen')
export class MediaProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly client: GoogleMediaClient,
  ) {
    super();
  }

  async process(job: Job<MediaJobData>): Promise<void> {
    const { versionId } = job.data;
    const version = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    if (!version) {
      this.logger.warn(`media 版本不存在，跳过 versionId=${versionId}`);
      return;
    }
    const { generation } = version;
    const type = generation.type as MediaType;

    try {
      await this.prisma.mediaVersion.update({
        where: { id: versionId },
        data: { status: 'generating' },
      });
      await this.publish(generation.conversationId, generation.id, versionId, type, 'generating');

      // 按类型调对应生成；图片快、视频长任务内部轮询
      const result =
        type === 'image'
          ? await this.client.generateImageBytes(version.prompt, version.model)
          : await this.client.generateVideoBytes(version.prompt, version.model);

      // 落盘：文件名 = <versionId>.<ext>（cuid 不可枚举）；filePath 存相对路径
      const ext = decideExt(result.mimeType);
      const fileName = `${versionId}.${ext}`;
      const dir = mediaDataDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, fileName), result.bytes);

      await this.prisma.mediaVersion.update({
        where: { id: versionId },
        data: { status: 'done', filePath: fileName, completedAt: new Date() },
      });
      await this.publish(generation.conversationId, generation.id, versionId, type, 'done');
      this.logger.log(`media 生成完成 versionId=${versionId} file=${fileName}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`media 生成失败 versionId=${versionId} ${message}`);
      await this.prisma.mediaVersion.update({
        where: { id: versionId },
        data: { status: 'failed', error: message, completedAt: new Date() },
      });
      await this.publish(
        generation.conversationId,
        generation.id,
        versionId,
        type,
        'failed',
        message,
      );
    }
  }

  private async publish(
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
