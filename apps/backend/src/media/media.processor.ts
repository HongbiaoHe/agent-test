import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Job } from 'bullmq';
import { AbortRegistry, MEDIA_ABORTS } from '../agent/abort-registry';
import { AigcService } from '../aigc/aigc.service';
import { videoRefRole } from '../aigc/aigc.catalog';
import type { AigcReference } from '../aigc/aigc.types';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { concatVideos } from './video-concat';
import {
  mediaDataDir,
  MediaService,
  MediaType,
  MEDIA_OPEN_STATUSES,
  readParams,
  RECONCILE_MAX_ATTEMPTS,
} from './media.service';

interface MediaJobData {
  versionId: string;
  /** 对账轮询（job 名 'poll'）的第几轮，用于封顶。 */
  attempt?: number;
}

/**
 * 媒体生成 worker：消费 media-gen 队列的三种 job。
 *
 *  - `generate`：等上游参考图就绪 → 把任务**提交**给 aigc（异步接单）→ 记下 task_id 后收工。
 *    生成本身在 aigc 那头跑，结果经回调回来（MediaCallbackController → MediaService.applyTaskResult）；
 *    worker 不干等，队列槽位立刻释放（此前直连模型时一条视频要占着槽位几分钟）。
 *  - `poll`：回调的兜底对账（回调是 best-effort，隧道没开就一条都到不了），见 scheduleReconcile。
 *  - `concat`：本地 ffmpeg 拼接，不经 aigc，整段逻辑不变。
 *
 * 只在状态变更时推流（generating / done|failed），轮询 tick 不推（避免前端失效风暴，设计 Issue 9）。
 */
// lockDuration 保持 1320_000（22 分钟）：generate job 现在只等参考图（最长 5 分钟）+ 提交，
// 但 concat 跑本地 ffmpeg 仍可能很久，留足余量避免 BullMQ 判 stalled 重跑（重复付费）。
// concurrency=3：BullMQ 默认 1，会把互不相干的任务排成一条队——一条在等上游参考图时后面全被堵住。
@Processor('media-gen', { concurrency: 3, lockDuration: 1_320_000 })
export class MediaProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly aigc: AigcService,
    private readonly media: MediaService,
    @Inject(MEDIA_ABORTS) private readonly aborts: AbortRegistry,
  ) {
    super();
  }

  async process(job: Job<MediaJobData>): Promise<void> {
    // 对账轮询不动状态、不占 abort 句柄，单独一条路径
    if (job.name === 'poll') {
      await this.reconcile(job.data.versionId, job.data.attempt ?? 1);
      return;
    }
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
    // 本 job 里能被打断的是「等上游参考图」与「ffmpeg 拼接」两段循环（每轮检查 signal）；
    // 已经提交给 aigc 的那些由 cancelByConversation 自己判失败（那时没有 worker 攥着它）。
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

      // 视频拼接（job 名 'concat'，见 MediaService.createConcat）：不调模型，跑本地 ffmpeg。
      // 与生成共用外层的状态流转 / 推流 / 失败收尾，只把"产物从哪来"这一段换掉。
      if (job.name === 'concat') {
        const fileName = await this.runConcat(
          version.referenceVersionIds,
          versionId,
          signal,
        );
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
        this.logger.log(`视频拼接完成 versionId=${versionId} file=${fileName}`);
        return;
      }

      // 参考图：等上游版本就绪，再换成 aigc 能下载的签名公网地址（它只收 URL，不收 base64）。
      const references = await this.loadRefUrls(
        version.referenceVersionIds,
        type,
        version.channel,
        { signal },
      );
      // 等参考图期间被停止：不再往 aigc 发单（发了就要付费），走 catch 的「用户已停止」收尾
      if (signal.aborted) throw new Error('用户已停止');

      // 接单：模型与档位取本版本落库的那份（建版本时已按目录归一），
      // 参考图会让 aigc 侧的 derived 维度变化，故 submit 内部还会再收窄一次并回传实际生效值。
      const { taskId, config } = await this.aigc.submit({
        type,
        prompt: version.prompt,
        config: {
          channel: version.channel ?? '',
          model: version.model,
          params: readParams(version.params),
        },
        references,
        callbackUrl: await this.media.callbackUrl(),
        // 回调里原样带回，方便在 aigc 后台按我方版本号对账（我方仍按 task_id 反查）
        metadata: { versionId, generationId: generation.id },
      });
      await this.media.markSubmitted(versionId, taskId, config);
      // 回调是 best-effort，配一条兜底轮询；到终态或轮满即止。
      // 它同时兜住一个窄窗口：回调比上面这行落库更快到达时按 task_id 反查不到版本、
      // 那次回调会被丢弃，30 秒后的第一轮对账会把结果补回来。
      await this.media.scheduleReconcile(versionId, 1);
      this.logger.log(
        `media 已提交 aigc versionId=${versionId} task=${taskId} ${config.channel}/${config.model}`,
      );
    } catch (e) {
      // 协作取消统一在此落 failed(用户已停止)；其余按原始报错落 failed
      const message = signal.aborted
        ? '用户已停止'
        : e instanceof Error
          ? e.message
          : String(e);
      if (signal.aborted) {
        this.logger.log(`media 生成已取消 versionId=${versionId}`);
      }
      // 经 settleFailed 落库（带未完成状态条件）而不是直接 update：
      // 提交成功后才抛错的情况下，回调可能已经把这版推向 done，不该被覆盖成 failed。
      await this.media.settleFailed(
        versionId,
        generation.id,
        generation.conversationId,
        type,
        message,
      );
    } finally {
      dispose();
    }
  }

  /**
   * 按 referenceVersionIds 的**顺序**把源视频接成一条，返回落盘的文件名。
   *
   * 顺序就是画布上的入边顺序（服务端 createdAt 升序），用户看到的预览顺序也是它——
   * 三处必须一致，否则"预览是这样、合出来是那样"。
   */
  private async runConcat(
    sourceIds: unknown,
    versionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const ids = Array.isArray(sourceIds)
      ? sourceIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (ids.length < 2) throw new Error('拼接至少需要两段视频');

    const rows = await this.prisma.mediaVersion.findMany({
      where: { id: { in: ids } },
      select: { id: true, filePath: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.filePath]));
    const dir = mediaDataDir();
    // 按 ids 的顺序取，不用 findMany 的返回顺序（那是数据库给的，不保证）
    const absPaths = ids.map((id) => {
      const f = byId.get(id);
      if (!f) throw new Error(`拼接源资产缺失：${id}`);
      return join(dir, f);
    });

    await mkdir(dir, { recursive: true });
    const fileName = `${versionId}.mp4`;
    const mode = await concatVideos(
      absPaths,
      join(dir, fileName),
      join(dir, `${versionId}.concat.txt`),
      signal,
    );
    this.logger.log(
      `ffmpeg 拼接 ${ids.length} 段（${mode}）versionId=${versionId}`,
    );
    return fileName;
  }

  /**
   * 把参考版本 id 列表换成 aigc 能下载的**签名公网地址**。
   *
   * 若参考版本尚未 done（queued/generating），轮询 DB 等待（默认每 5s，上限 5 分钟）——
   * 画布上常是「上游图还在生成，下游已被批准」。变 failed 或超时 → 抛错，让本版本 failed。
   * 顺序与传入 id 一致（视频首帧依赖第一张）。
   *
   * 视频只取**第一张**：byteplus/fal 的首尾帧一次只认一个 first_frame，
   * 其余渠道也没有「多张参考图」的一致语义——与改造前「视频取第一张作首帧」保持一致。
   */
  private async loadRefUrls(
    referenceVersionIds: unknown,
    type: MediaType,
    channel: string | null,
    opts: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<AigcReference[]> {
    const all = Array.isArray(referenceVersionIds)
      ? referenceVersionIds.filter((x): x is string => typeof x === 'string')
      : [];
    const ids = type === 'video' ? all.slice(0, 1) : all;
    if (ids.length === 0) return [];

    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 分钟
    const role: AigcReference['role'] =
      type === 'video' ? videoRefRole(channel ?? '') : 'reference';

    const refs: AigcReference[] = [];
    for (const id of ids) {
      const v = await this.waitForRef(
        id,
        pollIntervalMs,
        timeoutMs,
        opts.signal,
      );
      const url = await this.media.publicAssetUrl(id, v.filePath!);
      if (!url) {
        throw new Error(
          '参考图无法提供给 aigc：没有公网地址。请先跑 `pnpm tunnel` 开隧道，或配置 PUBLIC_BASE_URL',
        );
      }
      refs.push({ type: 'image', role, url });
    }
    return refs;
  }

  /**
   * 回调兜底对账：查一次 aigc 任务详情，没到终态就再排一轮，轮满判超时失败。
   *
   * 单次失败（网络抖动等）不判死本版本——继续排下一轮，最坏由轮数封顶收敛。
   */
  private async reconcile(versionId: string, attempt: number): Promise<void> {
    const version = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    if (!version || !MEDIA_OPEN_STATUSES.includes(version.status)) return;
    // 还没提交出去（generate job 尚未跑到 submit）：本轮什么都做不了，等下一轮
    if (version.providerTaskId) {
      try {
        const task = await this.aigc.getTask(version.providerTaskId);
        if ((await this.media.applyTaskResult(task)) !== 'pending') return;
      } catch (e) {
        this.logger.warn(
          `对账查询失败（第 ${attempt} 轮）versionId=${versionId}：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    if (attempt >= RECONCILE_MAX_ATTEMPTS) {
      await this.media.settleFailed(
        versionId,
        version.generationId,
        version.generation.conversationId,
        version.generation.type === 'video' ? 'video' : 'image',
        '生成超时：aigc 长时间未回结果',
      );
      return;
    }
    await this.media.scheduleReconcile(versionId, attempt + 1);
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
