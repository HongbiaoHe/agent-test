import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  BYTEPLUS_CHANNEL,
  closestAspectRatio,
  fitContain,
  fitCover,
  IMAGE_HISTORY_LIMIT,
  type ImageLayer,
  type ImageModelChoice,
  imageModelChoiceSchema,
} from '@agent-test/design-schema';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AigcService } from '../aigc/aigc.service';
import { isAigcTerminal } from '../aigc/aigc.types';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { DesignAssetsService } from './design-assets.service';
import {
  DESIGN_GEN_QUEUE,
  type DesignGenJob,
  errorMessage,
  findGenerating,
  sleep,
  withRetry,
} from './design-gen.util';
import {
  type DesignImageModel,
  designImageModels,
  resolveImageModel,
} from './design-image-models';
import { DesignOpRejected, DesignService } from './design.service';
import { bboxInBase } from './seedream/decompose-layout';
import {
  parseSize,
  SeedreamClient,
  type SeedreamOutput,
  seedreamSize,
} from './seedream/seedream.client';

export { DESIGN_GEN_QUEUE, type DesignGenJob } from './design-gen.util';

export interface StartGenerationInput {
  prompt: string;
  /** 额外参考图（CDN 地址），如产品图、参考图 */
  referenceUrls?: string[];
  /** 把图层当前的图也作为参考（做变体） */
  useCurrentAsReference?: boolean;
  /** 覆盖会话里选的生图模型 */
  imageModel?: ImageModelChoice;
  /** agent 指定用哪一家（会话里选的不是这家时，换成这家的默认档位） */
  engine?: 'gpt-image' | 'seedream';
}

const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 8 * 60_000;

/**
 * 单图层生成（问题 12）：人点「重新生成 / 文字生成图层」与 agent 的 generate_layer_image 共用。
 * 提交即把图层置 generating（旧图继续显示），结果回来裁透明边、contain 进原框、旧图进历史。
 * jobId 守卫：结果回来时图层已被再次生成或删除，就丢弃这次结果。
 */
@Injectable()
export class DesignGenerationService {
  private readonly logger = new Logger(DesignGenerationService.name);

  constructor(
    private readonly design: DesignService,
    private readonly assets: DesignAssetsService,
    private readonly aigc: AigcService,
    private readonly prisma: PrismaService,
    private readonly seedream: SeedreamClient,
    @InjectQueue(DESIGN_GEN_QUEUE) private readonly queue: Queue<DesignGenJob>,
  ) {}

  async imageModels(): Promise<DesignImageModel[]> {
    // aigc 目录挂了也别连累 Seedream：那一半当空
    const catalog = await this.aigc.catalog('image').catch((e: unknown) => {
      this.logger.warn(`读取 aigc 生图目录失败：${errorMessage(e)}`);
      return null;
    });
    return designImageModels(catalog, this.seedream.isConfigured());
  }

  /** 校验 → 图层置 generating → 入队。返回本次 jobId。 */
  async start(
    docId: string,
    layerId: string,
    input: StartGenerationInput,
    source: 'user' | 'agent',
  ): Promise<{ jobId: string }> {
    const row = await this.prisma.designDoc.findUniqueOrThrow({
      where: { id: docId },
      select: { imageModel: true },
    });
    const models = await this.imageModels();
    const choice = input.imageModel ?? parseChoice(row.imageModel);
    let resolved = resolveImageModel(models, choice);
    if (resolved && input.engine) {
      const wantSeedream = input.engine === 'seedream';
      if ((resolved.model.channel === BYTEPLUS_CHANNEL) !== wantSeedream) {
        const alt = models.find(
          (m) => (m.channel === BYTEPLUS_CHANNEL) === wantSeedream,
        );
        resolved = alt ? resolveImageModel([alt], null) : null;
      }
    }
    if (!resolved) {
      throw new BusinessException(
        ErrorCodes.DESIGN_NO_IMAGE_MODEL,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const jobId = randomUUID();
    try {
      await this.design.mutate(
        docId,
        (doc) => {
          const layer = doc.layers.find((l) => l.id === layerId);
          if (!layer) throw new DesignOpRejected(`图层不存在：${layerId}`);
          if (layer.type !== 'image') {
            throw new DesignOpRejected(
              ErrorCodes.DESIGN_LAYER_NOT_IMAGE.message,
            );
          }
          const box =
            layer.role === 'background'
              ? { width: doc.canvas.width, height: doc.canvas.height }
              : layer;
          const refs = [
            ...(input.useCurrentAsReference && layer.src ? [layer.src] : []),
            ...(input.referenceUrls ?? []),
          ].slice(0, Math.max(0, resolved.model.maxReferenceImages));
          const background =
            layer.role === 'background' ? 'opaque' : 'transparent';
          const params =
            resolved.model.channel === BYTEPLUS_CHANNEL
              ? {
                  size: seedreamSize(
                    box.width,
                    box.height,
                    resolved.resolution,
                  ),
                  resolution: resolved.resolution,
                  background,
                }
              : {
                  aspect_ratio: closestAspectRatio(
                    box.width,
                    box.height,
                    resolved.model.aspectRatios,
                  ),
                  resolution: resolved.resolution,
                  background,
                };
          return [
            {
              type: 'update_layers',
              updates: [
                {
                  id: layerId,
                  patch: {
                    status: 'generating',
                    generation: {
                      prompt: input.prompt,
                      channel: resolved.model.channel,
                      model: resolved.model.model,
                      params,
                      referenceUrls: refs,
                      jobId,
                    },
                  },
                },
              ],
            },
          ];
        },
        source,
      );
    } catch (e) {
      if (e instanceof DesignOpRejected) {
        throw new BusinessException(
          { code: ErrorCodes.DESIGN_OP_INVALID.code, message: e.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw e;
    }
    await this.queue.add(
      'generate',
      { docId, layerId, jobId, kind: 'generate' },
      { jobId },
    );
    return { jobId };
  }

  /** processor 调：aigc 走「提交 → 轮询 → 落结果」，Seedream 走同步请求。 */
  async run(job: DesignGenJob): Promise<void> {
    const layer = await this.currentLayer(job);
    if (!layer?.generation) return;
    if (layer.generation.channel === BYTEPLUS_CHANNEL) {
      await this.runSeedream(job, layer);
      return;
    }
    const gen = layer.generation;
    let taskId = gen.taskId;
    if (!taskId) {
      try {
        const submitted = await this.aigc.submit({
          type: 'image',
          prompt: gen.prompt,
          config: {
            channel: gen.channel,
            model: gen.model,
            params: Object.fromEntries(
              Object.entries(gen.params).filter(
                (kv): kv is [string, string] => typeof kv[1] === 'string',
              ),
            ),
          },
          references: gen.referenceUrls.map((url) => ({
            type: 'image' as const,
            role: 'reference' as const,
            url,
          })),
          metadata: {
            source: 'design',
            docId: job.docId,
            layerId: job.layerId,
          },
        });
        taskId = submitted.taskId;
      } catch (e) {
        await this.fail(job, errorMessage(e));
        return;
      }
      await this.rememberTask(job, taskId);
    } else {
      this.logger.log(
        `design 生成任务续跑 layer=${job.layerId} task=${taskId}`,
      );
    }

    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      // 图层被删 / 被再次生成：不再等这单
      if (!(await this.currentLayer(job))) return;
      const task = await this.aigc.getTask(taskId).catch((e: unknown) => {
        this.logger.warn(`查询任务失败 task=${taskId}：${String(e)}`);
        return null;
      });
      if (!task || !isAigcTerminal(task.status)) continue;
      const outputUrl = task.output_data?.image_url;
      if (task.status === 'completed' && outputUrl) {
        try {
          await withRetry(
            async () =>
              this.complete(job, await this.assets.fetchBytes(outputUrl)),
            3,
          );
        } catch (e) {
          // 下载产物 / 裁边 / 转存 CDN 任一步失败（实测有 fetch 超时）：必须落成 error，
          // 否则图层永远停在 generating、用户也没法重试
          await this.fail(job, `生成结果落地失败：${errorMessage(e)}`);
        }
        return;
      }
      const reason =
        [task.error_data?.code, task.error_data?.message]
          .filter(Boolean)
          .join(': ') || `任务 ${task.status}`;
      await this.fail(job, reason);
      return;
    }
    await this.fail(job, '生成超时');
  }

  /**
   * Seedream 单图层（同步接口，没有任务号可续跑；进程中途被杀就整单重跑）：
   * - background：文生图（不透明），按框比例传像素宽高；
   * - element 已有图（重新生成）：现图转带 alpha 的 PNG 作唯一输入，图生图 + background=transparent；
   * - element 没有图（新建）、不带参考图：给一张同尺寸的全透明 PNG 作唯一输入 + background=transparent，
   *   一次调用直接出透明主体（2026-11-04 实测 1024² 约 65s，四周 alpha=0、主体 alpha≈255）；
   * - element 没有图、带参考图：透明模式只收 1 张输入图，参考图带不进去，
   *   改为文生图（带参考、纯色底）→ 拆层取面积最大的子图层。
   */
  private async runSeedream(job: DesignGenJob, layer: ImageLayer) {
    const gen = layer.generation;
    if (!gen) return;
    const size =
      gen.params.size ??
      seedreamSize(layer.width, layer.height, gen.params.resolution ?? '2K');
    let bytes: Buffer;
    try {
      if (layer.role === 'background') {
        bytes = await this.seedreamBytes(
          await this.seedream.generate({
            prompt: gen.prompt,
            images: gen.referenceUrls,
            size,
          }),
        );
      } else if (layer.src) {
        const input = await this.assets.toSeedreamInput(
          await this.assets.fetchBytes(layer.src),
          { alpha: true },
        );
        bytes = await this.seedreamBytes(
          await this.seedream.generate({
            prompt: gen.prompt,
            images: [input],
            size,
            background: 'transparent',
          }),
        );
      } else if (!gen.referenceUrls.length) {
        bytes = await this.seedreamBytes(
          await this.seedream.generate({
            prompt: gen.prompt,
            images: [await this.assets.blankPngDataUrl(size)],
            size,
            background: 'transparent',
          }),
        );
      } else {
        bytes = await this.seedreamIsolated(
          gen.prompt,
          gen.referenceUrls,
          size,
        );
      }
    } catch (e) {
      await this.fail(job, errorMessage(e));
      return;
    }
    try {
      await withRetry(() => this.complete(job, bytes), 3);
    } catch (e) {
      await this.fail(job, `生成结果落地失败：${errorMessage(e)}`);
    }
  }

  /** 新建透明元素（带参考图）：文生图（纯色底）→ 拆层 → 取面积最大的子图层。 */
  private async seedreamIsolated(
    prompt: string,
    referenceUrls: string[],
    size: string,
  ): Promise<Buffer> {
    const opaque = await this.seedreamBytes(
      await this.seedream.generate({
        prompt: plainBackgroundPrompt(prompt),
        images: referenceUrls,
        size,
      }),
    );
    const parts = await this.seedream.decompose({
      image: await this.assets.toSeedreamInput(opaque, { alpha: false }),
      prompt: 'Separate the main subject from the plain background.',
    });
    const base = parts.find((p) => (p.z_index ?? 0) === 0);
    const baseSize = parseSize(base?.size) ?? (await this.sizeOf(opaque));
    const largest = parts
      .filter((p) => (p.z_index ?? 0) > 0)
      .map((p) => {
        const b = bboxInBase(p.bounding_box, baseSize);
        return { p, area: b ? (b[2] - b[0]) * (b[3] - b[1]) : 0 };
      })
      .sort((a, b) => b.area - a.area)[0];
    if (!largest) throw new Error('拆层没有分离出主体，换个更明确的提示词再试');
    return this.seedreamBytes(largest.p);
  }

  async seedreamBytes(out: SeedreamOutput): Promise<Buffer> {
    if (out.b64_json) return Buffer.from(out.b64_json, 'base64');
    if (out.url) return this.assets.fetchBytes(out.url);
    throw new Error('Seedream 返回里没有图片');
  }

  private async sizeOf(bytes: Buffer) {
    const meta = await sharp(bytes).metadata();
    return { width: meta.width ?? 1, height: meta.height ?? 1 };
  }

  private async complete(job: DesignGenJob, raw: Buffer): Promise<void> {
    const layer = await this.currentLayer(job);
    if (!layer) return;
    let bytes = raw;
    if (layer.role === 'element')
      bytes = await this.assets.trimTransparent(bytes);
    const stored = await this.assets.storeBuffer(
      bytes,
      'image/png',
      `design-${job.layerId}.png`,
    );
    await this.design.mutate(
      job.docId,
      (doc) => {
        const cur = findGenerating(doc, job);
        if (!cur?.generation) return null;
        const box =
          cur.role === 'background'
            ? fitCover(
                {
                  x: 0,
                  y: 0,
                  width: doc.canvas.width,
                  height: doc.canvas.height,
                },
                stored.width,
                stored.height,
              )
            : fitContain(cur, stored.width, stored.height);
        const history = cur.src
          ? [
              {
                src: cur.src,
                prompt: cur.history[0]?.prompt ?? cur.generation.prompt,
                createdAt: new Date().toISOString(),
              },
              ...cur.history,
            ].slice(0, IMAGE_HISTORY_LIMIT)
          : cur.history;
        return [
          {
            type: 'update_layers',
            updates: [
              {
                id: cur.id,
                patch: {
                  ...box,
                  src: stored.url,
                  status: 'ready',
                  generation: { ...cur.generation, error: undefined },
                  history,
                },
              },
            ],
          },
        ];
      },
      'system',
    );
    this.logger.log(
      `design 图层生成完成 doc=${job.docId} layer=${job.layerId}`,
    );
  }

  /** 公开给 processor 兜底：run 之外的意外异常也要把图层落成 error。 */
  async fail(job: DesignGenJob, reason: string): Promise<void> {
    this.logger.warn(
      `design 图层生成失败 doc=${job.docId} layer=${job.layerId}：${reason}`,
    );
    await this.design.mutate(
      job.docId,
      (doc) => {
        const cur = findGenerating(doc, job);
        if (!cur?.generation) return null;
        return [
          {
            type: 'update_layers',
            updates: [
              {
                id: cur.id,
                patch: {
                  status: 'error',
                  generation: {
                    ...cur.generation,
                    error: reason.slice(0, 1000),
                  },
                },
              },
            ],
          },
        ];
      },
      'system',
    );
  }

  /** 提交成功立刻把 taskId 记到图层上：任务被中断重跑时据此续轮询，而不是重新提交。 */
  private async rememberTask(job: DesignGenJob, taskId: string) {
    await this.design
      .mutate(
        job.docId,
        (doc) => {
          const cur = findGenerating(doc, job);
          if (!cur?.generation) return null;
          return [
            {
              type: 'update_layers',
              updates: [
                {
                  id: cur.id,
                  patch: { generation: { ...cur.generation, taskId } },
                },
              ],
            },
          ];
        },
        'system',
      )
      .catch((e: unknown) =>
        this.logger.warn(`记录 taskId 失败 layer=${job.layerId}：${String(e)}`),
      );
  }

  private async currentLayer(job: DesignGenJob): Promise<ImageLayer | null> {
    const { document } = await this.design.document(job.docId).catch(() => ({
      document: null,
    }));
    return document ? findGenerating(document, job) : null;
  }
}

function parseChoice(json: unknown): ImageModelChoice | null {
  const parsed = imageModelChoiceSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Seedream 文生图没有透明模式：把「透明背景」的说法换成纯色底，免得模型画出一块假棋盘格，
 * 再补一句纯色底，方便随后拆层把主体分离出来。
 */
export function plainBackgroundPrompt(prompt: string): string {
  const cleaned = prompt.replace(
    /\b(?:on|against|with)\s+(?:a\s+)?transparent\s+background\b/gi,
    'on a plain solid light gray background',
  );
  return /plain solid/i.test(cleaned)
    ? cleaned
    : `${cleaned}. Isolated subject on a plain solid light gray background, nothing else in the frame.`;
}
