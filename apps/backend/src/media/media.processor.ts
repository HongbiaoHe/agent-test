import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Job } from 'bullmq';
import {
  AbortRegistry,
  MEDIA_ABORTS,
  MEDIA_PAUSES,
} from '../agent/abort-registry';
import { AigcService } from '../aigc/aigc.service';
import { videoRefRole } from '../aigc/aigc.catalog';
import type { AigcMediaConfig, AigcReference } from '../aigc/aigc.types';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { concatVideos } from './video-concat';
import {
  abortableSleep,
  mockDelayMs,
  mockDuration,
  mockSize,
  renderMockImage,
  renderMockVideo,
  type MockCard,
} from './mock-media';
import {
  asAssetType,
  asMediaType,
  extFromUrl,
  mediaDataDir,
  MediaService,
  MediaType,
  MEDIA_OPEN_STATUSES,
  MEDIA_PAUSED,
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
/** 暂停窗口：等待段用 signal（停止或暂停都会打断），到提交 / 本地出片那一刻 close()。 */
interface PauseGate {
  signal: AbortSignal;
  close: () => void;
}

/** 拼接等待在途源视频的总上限（15 分钟，须小于 lockDuration）。 */
const CONCAT_SOURCE_WAIT_MS = 15 * 60_000;

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
    @Inject(MEDIA_PAUSES) private readonly pauses: AbortRegistry,
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
    // 暂停窗口：第一时间登记（排队中被拾取的那一瞬，暂停接口移不走 job，就靠它叫停），
    // 到「提交给 aigc / 开始本地出片」那一刻关掉——之后云端停不下来，暂停不再生效。
    const pause = this.pauses.register(versionId);
    const version = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    if (!version) {
      pause.dispose();
      this.logger.warn(`media 版本不存在，跳过 versionId=${versionId}`);
      return;
    }
    const { generation } = version;
    const type = generation.type as MediaType;

    // 协作取消句柄：stop 端点经 MediaService.cancelByConversation → abort(versionId)。
    // 本 job 里能被打断的是「等上游参考图」与「ffmpeg 拼接」两段循环（每轮检查 signal）；
    // 已经提交给 aigc 的那些由 cancelByConversation 自己判失败（那时没有 worker 攥着它）。
    const { signal, dispose } = this.aborts.register(versionId);
    const gate: PauseGate = {
      // 等待段同时听「停止」与「暂停」
      signal: AbortSignal.any([signal, pause.signal]),
      close: () => {
        pause.dispose();
        // 关窗前已被叫停：不再往下走（发单就要付费）
        if (pause.signal.aborted) throw new Error('用户已暂停');
      },
    };
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
          gate,
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

      // 测试模式：产物换成本地占位素材，其余（上游等待、状态推送、收尾）与真实生成一致
      if (version.mock) {
        const { fileName, config } = await this.runMock(
          version,
          generation.id,
          type,
          signal,
          gate,
        );
        await this.prisma.mediaVersion.update({
          where: { id: versionId },
          data: {
            status: 'done',
            filePath: fileName,
            // 与 markSubmitted 一致：落实际生效的档位，界面显示的就是「真会提交」的那份
            channel: config.channel,
            model: config.model,
            params: config.params,
            completedAt: new Date(),
          },
        });
        await this.publish(
          generation.conversationId,
          generation.id,
          versionId,
          type,
          'done',
        );
        this.logger.log(`模拟生成完成 versionId=${versionId} file=${fileName}`);
        return;
      }

      // 参考图：等上游版本就绪，再换成 aigc 能下载的签名公网地址（它只收 URL，不收 base64）。
      const references = await this.loadRefUrls(
        version.referenceVersionIds,
        type,
        version.model,
        { signal: gate.signal },
      );
      // 等参考图期间被停止：不再往 aigc 发单（发了就要付费），走 catch 的「用户已停止」收尾
      if (signal.aborted) throw new Error('用户已停止');
      gate.close();

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
      // 提交的 HTTP 调用期间被停止：cancelByConversation 那一刻本版本还没有 task_id，只发了 abort。
      // aigc 没有取消接口，那单会照常跑完，但我们不再采纳——走 catch 判 cancelled，也不排对账。
      if (signal.aborted) throw new Error('用户已停止');
      // 回调是 best-effort，配一条兜底轮询；到终态或轮满即止。
      // 它同时兜住一个窄窗口：回调比上面这行落库更快到达时按 task_id 反查不到版本、
      // 那次回调会被丢弃，30 秒后的第一轮对账会把结果补回来。
      await this.media.scheduleReconcile(versionId, 1);
      this.logger.log(
        `media 已提交 aigc versionId=${versionId} task=${taskId} ${config.channel}/${config.model}`,
      );
    } catch (e) {
      // 提交前被暂停（且没被停止）：落 paused，等继续时重新入队
      if (pause.signal.aborted && !signal.aborted) {
        await this.media.settlePaused(versionId);
        this.logger.log(`media 生成已暂停 versionId=${versionId}`);
        return;
      }
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
        signal.aborted ? 'cancelled' : 'failed',
      );
    } finally {
      dispose();
      pause.dispose();
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
    gate: PauseGate,
  ): Promise<string> {
    const ids = Array.isArray(sourceIds)
      ? sourceIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (ids.length < 2) throw new Error('拼接至少需要两段视频');

    const dir = mediaDataDir();
    // 源可能还在排队 / 生成（画布上一口气触发了整条链）：逐段等到 done。
    // 共用一个截止时间——真实生视频常超过 5 分钟，比参考图的等待放宽，但要留在 lockDuration 内。
    const deadline = Date.now() + CONCAT_SOURCE_WAIT_MS;
    // 按 ids 的顺序取（入边顺序）；等齐之前都还能暂停
    const sources: Awaited<ReturnType<MediaProcessor['waitForRef']>>[] = [];
    for (const id of ids) {
      sources.push(
        await this.waitForRef(
          id,
          5_000,
          Math.max(deadline - Date.now(), 0),
          gate.signal,
        ),
      );
    }
    gate.close();
    // aigc 产物只有 CDN 地址：先下到临时目录给 ffmpeg 读，拼完连目录一起删
    const tmp = await mkdtemp(join(tmpdir(), 'media-concat-'));
    try {
      const absPaths: string[] = [];
      for (const src of sources) {
        const id = src.id;
        if (src.filePath) {
          absPaths.push(join(dir, src.filePath));
        } else if (src.url) {
          absPaths.push(await downloadTo(src.url, tmp, id, signal));
        } else {
          throw new Error(`拼接源资产缺失：${id}`);
        }
      }

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
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * 把参考版本 id 列表换成 aigc 能下载的**签名公网地址**。
   *
   * 若参考版本尚未 done（queued/generating），轮询 DB 等待（默认每 5s，上限 5 分钟）——
   * 画布上常是「上游图还在生成，下游已被批准」。变 failed 或超时 → 抛错，让本版本 failed。
   * 顺序与传入 id 一致（提示词里按 `Image 1` / `Image 2` 引用素材时靠的就是这个顺序）。
   *
   * 每个引用按它所属 generation 的类型提交（image / video / audio——用户上传的视频、音频也在此列）。
   * 图片的 role 默认 `reference`，只有 i2v-only 的模型退回 `first_frame`——见 videoRefRole；
   * 挂 first_frame 时**只取第一张图**：上游一次只认一个首帧。视频 / 音频恒为 `reference`。
   * 超出该模型各类型上限的部分由 AigcService.submit 截掉。
   */
  private async loadRefUrls(
    referenceVersionIds: unknown,
    type: MediaType,
    model: string,
    opts: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<AigcReference[]> {
    const picked = await this.pickRefs(referenceVersionIds, type, model);
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 分钟

    const refs: AigcReference[] = [];
    for (const { id, refType, role } of picked) {
      const v = await this.waitForRef(
        id,
        pollIntervalMs,
        timeoutMs,
        opts.signal,
      );
      const url = await this.refUrl(v);
      if (!url) {
        throw new Error(
          '参考图无法提供给 aigc：没有公网地址。请先跑 `pnpm tunnel` 开隧道，或配置 PUBLIC_BASE_URL',
        );
      }
      refs.push({ type: refType, role, url });
    }
    return refs;
  }

  /**
   * 挑出这次要提交（因而要等待）的参考：按传入顺序，每个按所属 generation 的类型提交；
   * 首帧模式只取第一张图（多出来的图不该被等待、也不该让本版本失败）。
   */
  private async pickRefs(
    referenceVersionIds: unknown,
    type: MediaType,
    model: string,
  ): Promise<
    {
      id: string;
      generationId: string | null;
      refType: AigcReference['type'];
      role: AigcReference['role'];
    }[]
  > {
    const all = Array.isArray(referenceVersionIds)
      ? referenceVersionIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (all.length === 0) return [];
    const imageRole: AigcReference['role'] =
      type === 'video' ? videoRefRole(model) : 'reference';
    // 先一次查出各引用的类型，再决定等哪些
    const rows = await this.prisma.mediaVersion.findMany({
      where: { id: { in: all } },
      select: {
        id: true,
        generationId: true,
        generation: { select: { type: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    let images = 0;
    const picked: {
      id: string;
      generationId: string | null;
      refType: AigcReference['type'];
      role: AigcReference['role'];
    }[] = [];
    for (const id of all) {
      const row = byId.get(id);
      const refType = (row && asAssetType(row.generation.type)) ?? 'image';
      if (refType === 'image') {
        if (imageRole === 'first_frame' && images >= 1) continue;
        images++;
      }
      picked.push({
        id,
        generationId: row?.generationId ?? null,
        refType,
        role: refType === 'image' ? imageRole : 'reference',
      });
    }
    return picked;
  }

  /**
   * 测试模式（Mock）：用本地占位素材顶替 aigc 产物，返回落盘的文件名与实际生效的档位。
   *
   * 只换掉「调 aigc」这一步：照常等上游参考就绪（依赖关系是真的），照常按真实提交的规则截参考、
   * 收窄档位（画面上印的就是真会提交的那份），再按类型随机等一段时间模拟出片耗时。
   * 不需要参考的公网地址——不往外发任何请求。
   */
  private async runMock(
    version: {
      id: string;
      prompt: string;
      model: string;
      channel: string | null;
      params: unknown;
      referenceVersionIds: unknown;
    },
    generationId: string,
    type: MediaType,
    signal: AbortSignal,
    gate: PauseGate,
  ): Promise<{ fileName: string; config: AigcMediaConfig }> {
    if (type !== 'image' && type !== 'video') {
      throw new Error(`测试模式只支持生图 / 生视频（收到 ${type}）`);
    }
    const picked = await this.pickRefs(
      version.referenceVersionIds,
      type,
      version.model,
    );
    for (const ref of picked) {
      await this.waitForRef(ref.id, 5_000, 5 * 60_000, gate.signal);
    }
    // 与真实生成一致：参考齐了就算「已提交」，之后的模拟耗时不能暂停
    gate.close();
    const { config, kept } = await this.aigc.prepareSubmission({
      type,
      config: {
        channel: version.channel ?? '',
        model: version.model,
        params: readParams(version.params),
      },
      references: picked.map((r) => ({
        type: r.refType,
        role: r.role,
        url: '',
      })),
    });
    await abortableSleep(mockDelayMs(type), signal);

    // 画面上的标题与引用：取画布节点的标题（节点回填 generationId 后才查得到，这时早已回填）
    const usedRefs = picked.filter((_, i) => kept[i]);
    const nodes = await this.prisma.canvasNode.findMany({
      where: {
        mediaGenerationId: {
          in: [generationId, ...usedRefs.flatMap((r) => r.generationId ?? [])],
        },
      },
      select: { mediaGenerationId: true, label: true },
    });
    const labelOf = (gid: string | null) =>
      nodes.find((n) => n.mediaGenerationId === gid)?.label?.trim();
    const params = config.params;
    const card: MockCard = {
      title:
        labelOf(generationId) ||
        (type === 'video' ? 'Mock video' : 'Mock image'),
      lines: [
        [config.model, ...Object.values(params)].join(' · '),
        usedRefs.length
          ? `refs: ${usedRefs.map((r) => `${labelOf(r.generationId) || r.id.slice(-6)} (${r.refType})`).join(', ')}`
          : 'refs: none',
        version.prompt,
      ],
    };

    const dir = mediaDataDir();
    await mkdir(dir, { recursive: true });
    const size = mockSize(type, params.aspect_ratio);
    if (type === 'image') {
      const fileName = `${version.id}.png`;
      await renderMockImage(join(dir, fileName), card, size);
      return { fileName, config };
    }
    const tmp = await mkdtemp(join(tmpdir(), 'media-mock-'));
    try {
      const frame = join(tmp, 'frame.png');
      await renderMockImage(frame, card, size);
      const fileName = `${version.id}.mp4`;
      await renderMockVideo(
        join(dir, fileName),
        frame,
        mockDuration(params),
        params.with_audio === 'true',
        signal,
      );
      return { fileName, config };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * 参考图给 aigc 的地址：已存 CDN 地址（aigc 产物）就直接用——那是 aigc 自己的永久链接，
   * aigc 当然下得到，也不需要隧道。只有本地文件的版本（未回填的历史数据）用我方签名公网地址；
   * 仍没有公网基址时，有 task_id 的再向 aigc 查一次产物地址（2026-10-18 实测：没隧道时靠它）。
   * 都没有返回 null，由调用方报错。
   */
  private async refUrl(v: {
    id: string;
    url: string | null;
    filePath: string | null;
    providerTaskId: string | null;
  }): Promise<string | null> {
    if (v.url) return v.url;
    if (v.filePath) {
      const own = await this.media.publicAssetUrl(v.id, v.filePath);
      if (own) return own;
    }
    if (!v.providerTaskId) return null;
    const task = await this.aigc.getTask(v.providerTaskId);
    return (
      task.output_data?.image_url ??
      task.output_data?.video_url ??
      task.output_data?.audio_url ??
      null
    );
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
        asMediaType(version.generation.type),
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
  ): Promise<{
    id: string;
    url: string | null;
    filePath: string | null;
    providerTaskId: string | null;
  }> {
    let deadline = Date.now() + timeoutMs;

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
        if (!v.url && !v.filePath) {
          throw new Error(
            `参考图版本资产缺失（versionId=${refId} 无 url 与 filePath）`,
          );
        }
        return v;
      }
      if (v.status === 'failed' || v.status === 'cancelled') {
        throw new Error(`参考图未能就绪：${refId} ${v.status}`);
      }
      // 上游被暂停：暂停的时间不算进等待超时，继续后重新计时
      if (v.status === MEDIA_PAUSED) deadline = Date.now() + timeoutMs;
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

/** 把一段 CDN 资产下到 dir（文件名 <id>.<ext>），返回绝对路径。失败即抛（外层落 failed）。 */
async function downloadTo(
  url: string,
  dir: string,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!res.ok) throw new Error(`下载拼接源失败 HTTP ${res.status} ${url}`);
  const absPath = join(dir, `${id}.${extFromUrl(url, 'video')}`);
  await writeFile(absPath, Buffer.from(await res.arrayBuffer()));
  return absPath;
}
