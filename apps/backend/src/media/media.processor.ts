import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { GoogleMediaClient, MediaRef } from './google-media.client';
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

/** 由参考资产文件后缀推 MIME（图生图/视频首帧的 inlineData/image 需要它）。 */
export function mimeForExt(filePath: string): string {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  // 参考图只允许 image 类型版本（service 已校验），兜底 png
  return 'image/png';
}

/**
 * 媒体生成 worker：消费 media-gen 队列的 { versionId }。
 * 流程：load version+generation → generating(推流) → 调 google client → 落盘 → done/failed(推流)。
 * 只在状态变更时推流（generating / done|failed），轮询 tick 不推（避免前端失效风暴，设计 Issue 9）。
 */
// lockDuration ≥ 视频轮询上限（10min）：BullMQ 默认 30s 锁靠续租维持，worker 短暂卡顿即判 stalled
// 重跑 → 重复付费生成。显式拉长锁时长消除该风险。
@Processor('media-gen', { lockDuration: 660_000 })
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

      // 参考图：从 DB 取引用版本的 filePath → 读盘转 base64。资产缺失则抛错使本版本 failed（不静默忽略）。
      const refs = await this.loadRefs(version.referenceVersionIds);

      // 按类型调对应生成；图片快、视频长任务内部轮询。
      // 图生图：refs 全传；视频首帧：仅取第一张参考图。
      const result =
        type === 'image'
          ? await this.client.generateImageBytes(version.prompt, version.model, refs)
          : await this.client.generateVideoBytes(version.prompt, version.model, {
              firstFrame: refs[0],
            });

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

  /**
   * 把参考版本 id 列表解析为 base64 字节 + MIME。
   * filePath 缺失（版本未落盘）或磁盘文件读不到 → 抛错（不静默忽略，让本版本 failed 并把原因带给前端）。
   * 顺序与传入 id 一致（视频首帧依赖第一张）。
   */
  private async loadRefs(referenceVersionIds: unknown): Promise<MediaRef[]> {
    const ids = Array.isArray(referenceVersionIds) ? (referenceVersionIds as string[]) : [];
    if (ids.length === 0) return [];

    const versions = await this.prisma.mediaVersion.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(versions.map((v) => [v.id, v]));
    const dir = mediaDataDir();

    const refs: MediaRef[] = [];
    for (const id of ids) {
      const v = byId.get(id);
      if (!v?.filePath) {
        throw new Error(`参考图版本资产缺失（versionId=${id} 无 filePath）`);
      }
      const data = await readFile(join(dir, v.filePath)); // 文件不存在会抛 ENOENT → 本版本 failed
      refs.push({ data: data.toString('base64'), mimeType: mimeForExt(v.filePath) });
    }
    return refs;
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
