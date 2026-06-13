import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Job } from 'bullmq';
import { AbortRegistry, MEDIA_ABORTS } from '../agent/abort-registry';
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
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg'))
    return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  // 参考图只允许 image 类型版本（service 已校验），兜底 png
  return 'image/png';
}

/**
 * 媒体生成 worker：消费 media-gen 队列的 { versionId }。
 * 流程：load version+generation → generating(推流) → 调 google client → 落盘 → done/failed(推流)。
 * 只在状态变更时推流（generating / done|failed），轮询 tick 不推（避免前端失效风暴，设计 Issue 9）。
 */
// lockDuration 提高到 1320_000（22 分钟）：参考图等待最长 5 分钟 + 视频生成最长 10 分钟，
// 两者串联最坏情况约 15 分钟，1320s 留足余量，避免 BullMQ 判 stalled 重跑（重复付费）。
@Processor('media-gen', { lockDuration: 1_320_000 })
export class MediaProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly client: GoogleMediaClient,
    @Inject(MEDIA_ABORTS) private readonly aborts: AbortRegistry,
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

    // 协作取消句柄：stop 端点经 MediaService.cancelByConversation → abort(versionId)。
    // 视频轮询与参考图等待循环每轮检查 signal；图片单次短调用，结束后检查并丢弃结果。
    const { signal, dispose } = this.aborts.register(versionId);
    try {
      await this.prisma.mediaVersion.update({
        where: { id: versionId },
        data: { status: 'generating' },
      });
      await this.publish(
        generation.conversationId,
        generation.id,
        versionId,
        type,
        'generating',
      );

      // 参考图：从 DB 取引用版本的 filePath → 读盘转 base64。资产缺失则抛错使本版本 failed（不静默忽略）。
      const refs = await this.loadRefs(version.referenceVersionIds, { signal });

      // 按类型调对应生成；图片快、视频长任务内部轮询。
      // 图生图：refs 全传；视频首帧：仅取第一张参考图。
      const result =
        type === 'image'
          ? await this.client.generateImageBytes(
              version.prompt,
              version.model,
              refs,
            )
          : await this.client.generateVideoBytes(
              version.prompt,
              version.model,
              {
                firstFrame: refs[0],
                signal,
              },
            );
      // 图片调用期间被停止：结果作废（不落盘），统一走 catch 的「用户已停止」收尾
      if (signal.aborted) throw new Error('用户已停止');

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
      await this.publish(
        generation.conversationId,
        generation.id,
        versionId,
        type,
        'done',
      );
      this.logger.log(`media 生成完成 versionId=${versionId} file=${fileName}`);
    } catch (e) {
      // 协作取消统一在此落 failed(用户已停止)；其余按原始报错落 failed
      const message = signal.aborted
        ? '用户已停止'
        : e instanceof Error
          ? e.message
          : String(e);
      if (signal.aborted) {
        this.logger.log(`media 生成已取消 versionId=${versionId}`);
      } else {
        this.logger.error(`media 生成失败 versionId=${versionId} ${message}`);
      }
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
    } finally {
      dispose();
    }
  }

  /**
   * 把参考版本 id 列表解析为 base64 字节 + MIME。
   * 若参考版本尚未 done（queued/generating），轮询 DB 等待（默认每 5s，上限 5 分钟）。
   * 变 failed 或超时 → 抛错，让本版本 failed 并把原因带给前端。
   * filePath 缺失或磁盘文件读不到 → 同样抛错（不静默忽略）。
   * 顺序与传入 id 一致（视频首帧依赖第一张）。
   */
  private async loadRefs(
    referenceVersionIds: unknown,
    opts: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MediaRef[]> {
    const ids = Array.isArray(referenceVersionIds)
      ? (referenceVersionIds as string[])
      : [];
    if (ids.length === 0) return [];

    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 分钟

    const dir = mediaDataDir();
    const refs: MediaRef[] = [];

    for (const id of ids) {
      const v = await this.waitForRef(
        id,
        pollIntervalMs,
        timeoutMs,
        opts.signal,
      );
      const data = await readFile(join(dir, v.filePath!)); // 文件不存在会抛 ENOENT → 本版本 failed
      refs.push({
        data: data.toString('base64'),
        mimeType: mimeForExt(v.filePath!),
      });
    }
    return refs;
  }

  /**
   * 等待单个参考版本就绪（status=done）。
   * queued/generating → 轮询；done → 立即返回；failed/超时 → 抛错。
   * 抽成独立方法便于单测（可注入小间隔参数）。
   */
  async waitForRef(
    refId: string,
    pollIntervalMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ id: string; filePath: string | null }> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      // 协作取消：参考图等待最长 5 分钟，停止后不再干等
      if (signal?.aborted) throw new Error('用户已停止');
      const v = await this.prisma.mediaVersion.findUnique({
        where: { id: refId },
      });
      if (!v) {
        throw new Error(`参考图版本不存在（versionId=${refId}）`);
      }
      if (v.status === 'done') {
        if (!v.filePath) {
          throw new Error(
            `参考图版本资产缺失（versionId=${refId} 无 filePath）`,
          );
        }
        return v;
      }
      if (v.status === 'failed') {
        throw new Error(`参考图未能就绪：${refId} ${v.status}`);
      }
      // queued / generating：继续等待
      if (Date.now() >= deadline) {
        throw new Error(
          `参考图未能就绪：${refId} ${v.status}（等待超时 ${timeoutMs}ms）`,
        );
      }
      await sleep(pollIntervalMs);
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

/** 简单异步等待（用于轮询间隔；慢路径沙箱外逻辑，直接 setTimeout 即可）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
