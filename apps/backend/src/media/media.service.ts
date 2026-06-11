import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { AbortRegistry, MEDIA_ABORTS } from '../agent/abort-registry';
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
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    @InjectQueue('media-gen') private readonly queue: Queue,
    @Inject(MEDIA_ABORTS) private readonly aborts: AbortRegistry,
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
    referenceVersionIds?: string[],
  ): Promise<{ generationId: string; versionId: string }> {
    const model =
      type === 'image'
        ? process.env.MEDIA_IMAGE_MODEL ?? 'gemini-3.1-flash-image-preview'
        : process.env.MEDIA_VIDEO_MODEL ?? 'veo-3.1-generate-preview';

    // 入队前先校验参考图：不合法直接抛错，不建任何 DB 行（避免留下脏 generation）。
    await this.validateReferences(referenceVersionIds, userId);

    const generation = await this.prisma.mediaGeneration.create({
      data: {
        conversationId,
        userId,
        type,
        versions: {
          create: {
            prompt,
            model,
            status: 'queued',
            // 无参考时存 null（而非空数组）：list 接口再统一默认 []
            referenceVersionIds: referenceVersionIds ?? undefined,
          },
        },
      },
      include: { versions: true },
    });
    const version = generation.versions[0];

    // jobId=versionId：stop 时可按版本号定位并移除排队中的 job
    await this.queue.add('generate', { versionId: version.id }, { jobId: version.id });
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
    referenceVersionIds?: string[],
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

    // 参考图缺省继承上一版（last.referenceVersionIds 是 Json，按 string[] 取）；
    // 显式传入则覆盖。无论来源都要过校验（继承的旧引用也可能已被改名/删除，理论上 done 版本不会，但仍统一校验）。
    const finalRefs =
      referenceVersionIds ??
      (Array.isArray(last?.referenceVersionIds)
        ? (last.referenceVersionIds as string[])
        : undefined);
    await this.validateReferences(finalRefs, userId);

    const version = await this.prisma.mediaVersion.create({
      data: {
        generationId,
        prompt: finalPrompt,
        model,
        status: 'queued',
        referenceVersionIds: finalRefs ?? undefined,
      },
    });

    // jobId=versionId：stop 时可按版本号定位并移除排队中的 job
    await this.queue.add('generate', { versionId: version.id }, { jobId: version.id });
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
   * 会话级取消所有未完成的媒体生成（stop 端点用，设计见
   * docs/superpowers/specs/2026-06-11-stop-run-design.md）。
   *
   * - queued：先尝试从队列移除 job（jobId=versionId）；移除失败（job 刚被拾取为
   *   active，BullMQ 不允许 remove）则落到协作 abort 分支，由 processor 收尾。
   *   移除成功后本层直接把版本置 failed(用户已停止) 并推流。
   * - generating：mediaAborts.abort(versionId) 协作取消——视频轮询/参考图等待循环
   *   每轮检查 signal，processor 的 catch 统一落 failed。
   */
  async cancelByConversation(conversationId: string): Promise<void> {
    const versions = await this.prisma.mediaVersion.findMany({
      where: {
        status: { in: ['queued', 'generating'] },
        generation: { conversationId },
      },
      include: { generation: true },
    });

    for (const v of versions) {
      if (v.status === 'queued') {
        try {
          const job = await this.queue.getJob(v.id);
          if (job) {
            await job.remove();
            await this.prisma.mediaVersion.update({
              where: { id: v.id },
              data: { status: 'failed', error: '用户已停止', completedAt: new Date() },
            });
            await this.publishUpdate(
              conversationId,
              v.generationId,
              v.id,
              v.generation.type as MediaType,
              'failed',
              '用户已停止',
            );
            continue;
          }
        } catch (e) {
          // job 刚被拾取为 active 时 remove 会抛错——落到下面的协作 abort 分支
          this.logger.warn(`media job 移除失败，转协作取消 versionId=${v.id}: ${String(e)}`);
        }
      }
      this.aborts.abort(v.id);
    }
  }

  /**
   * 校验参考图版本的「合法性」：每个 id 必须存在、generation.type=image、归属同 userId。
   * status 允许 queued / generating / done（就绪性由 processor 执行时等待）；status=failed 仍拒绝。
   * 任一不满足抛 MEDIA_REF_INVALID。空/未传则直接通过（参考图可选）。
   * 为什么一次 findMany 而非逐个查：减少往返，并用「查到数 < 传入数」捕获「不存在」。
   */
  private async validateReferences(
    referenceVersionIds: string[] | undefined,
    userId: string,
  ): Promise<void> {
    if (!referenceVersionIds || referenceVersionIds.length === 0) return;

    const found = await this.prisma.mediaVersion.findMany({
      where: { id: { in: referenceVersionIds } },
      include: { generation: true },
    });

    // 不存在的 id（查到数不足）即非法
    if (found.length !== referenceVersionIds.length) {
      throw new BusinessException(ErrorCodes.MEDIA_REF_INVALID, HttpStatus.BAD_REQUEST);
    }
    for (const v of found) {
      // status=failed 明确拒绝；queued/generating/done 均视为合法（就绪性由 processor 等待）
      const validStatus = v.status === 'queued' || v.status === 'generating' || v.status === 'done';
      const ok = validStatus && v.generation.type === 'image' && v.generation.userId === userId;
      if (!ok) {
        throw new BusinessException(ErrorCodes.MEDIA_REF_INVALID, HttpStatus.BAD_REQUEST);
      }
    }
  }

  /**
   * 列出会话下全部生成位（含全部版本，均按 createdAt desc）。
   * 归属校验：仅返回该 userId 的生成位（多租户隔离经 userId 关联）。
   */
  async listForConversation(conversationId: string, userId: string) {
    const generations = await this.prisma.mediaGeneration.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { createdAt: 'desc' } } },
    });
    // 每个 version 的 referenceVersionIds 归一为 string[]（Json? 可能是 null/数组）→ 前端无需判空
    return generations.map((g) => ({
      ...g,
      versions: g.versions.map((v) => ({
        ...v,
        referenceVersionIds: Array.isArray(v.referenceVersionIds)
          ? (v.referenceVersionIds as string[])
          : [],
      })),
    }));
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
