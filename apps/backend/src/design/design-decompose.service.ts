import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  BYTEPLUS_CHANNEL,
  createImageLayer,
  type ImageLayer,
  SEEDREAM_MODEL,
} from '@agent-test/design-schema';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { DesignAssetsService } from './design-assets.service';
import {
  DESIGN_GEN_QUEUE,
  type DesignGenJob,
  errorMessage,
  findGenerating,
  withRetry,
} from './design-gen.util';
import { DesignGenerationService } from './design-generation.service';
import { DesignOpRejected, DesignService } from './design.service';
import { bboxInBase, placeDecomposedChild } from './seedream/decompose-layout';
import {
  parseSize,
  SeedreamClient,
  type SeedreamOutput,
} from './seedream/seedream.client';

/** 拆层输入的总像素下限（官方：≥ 512×512） */
const MIN_DECOMPOSE_PIXELS = 512 * 512;
/** 输入长边上限：总像素官方上限 6000×6000，限 4096 也让 data URL 远小于 30MB */
const MAX_DECOMPOSE_SIDE = 4096;

interface StoredPart {
  out: SeedreamOutput;
  url: string;
  box: number[] | null;
}

/**
 * 拆层（Seedream 5.0 Pro layer_decomposition）：一个图片图层 → 底图 + 最多 16 个透明子图层。
 * 初始生成（整图拆开）、复刻参考图、编辑器里的「拆分」都走它。
 *
 * 期间被拆图层显示 generating（generation.operation=decompose，旧图照常显示）；完成后在**一次 mutate**
 * 里删掉它、在原 z 序位置插入底图与子图层（按 z_index 自底向上）。整单失败官方不给部分结果，
 * 失败就把被拆图层落成 error，重试仍走拆层。
 */
@Injectable()
export class DesignDecomposeService {
  private readonly logger = new Logger(DesignDecomposeService.name);

  constructor(
    private readonly design: DesignService,
    private readonly assets: DesignAssetsService,
    private readonly generation: DesignGenerationService,
    private readonly seedream: SeedreamClient,
    @InjectQueue(DESIGN_GEN_QUEUE) private readonly queue: Queue<DesignGenJob>,
  ) {}

  enabled(): boolean {
    return this.seedream.isConfigured();
  }

  async start(
    docId: string,
    layerId: string,
    prompt: string | undefined,
    source: 'user' | 'agent',
  ): Promise<{ jobId: string }> {
    if (!this.enabled()) {
      throw new BusinessException(
        ErrorCodes.DESIGN_DECOMPOSE_UNAVAILABLE,
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
          if (!layer.src) throw new DesignOpRejected('图层还没有图，无法拆分');
          if (layer.status === 'generating') {
            throw new DesignOpRejected('图层正在生成中，等它完成再拆分');
          }
          const prev = layer.generation ?? {
            prompt: '',
            channel: BYTEPLUS_CHANNEL,
            model: SEEDREAM_MODEL,
            params: {},
            referenceUrls: [],
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
                      ...prev,
                      jobId,
                      taskId: undefined,
                      operation: 'decompose',
                      error: undefined,
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
      'decompose',
      { docId, layerId, jobId, kind: 'decompose', prompt },
      { jobId },
    );
    return { jobId };
  }

  async run(job: DesignGenJob): Promise<void> {
    const layer = await this.current(job);
    if (!layer?.src) return;
    let parts: SeedreamOutput[];
    try {
      const image = await this.assets.toSeedreamInput(
        await this.assets.fetchBytes(layer.src),
        {
          alpha: false,
          maxSide: MAX_DECOMPOSE_SIDE,
          minPixels: MIN_DECOMPOSE_PIXELS,
        },
      );
      parts = await this.seedream.decompose({ image, prompt: job.prompt });
    } catch (e) {
      await this.generation.fail(job, `拆层失败：${errorMessage(e)}`);
      return;
    }
    if (!(await this.current(job))) return;
    try {
      await withRetry(() => this.complete(job, parts), 3);
    } catch (e) {
      await this.generation.fail(job, `拆层结果落地失败：${errorMessage(e)}`);
    }
  }

  private async complete(job: DesignGenJob, parts: SeedreamOutput[]) {
    const layer = await this.current(job);
    if (!layer) return;
    const baseOut = parts.find((p) => (p.z_index ?? 0) === 0);
    const children = parts.filter((p) => (p.z_index ?? 0) > 0);
    if (!children.length) {
      throw new Error('没有拆出可分离的元素');
    }

    // 底图：被拆的是透明元素时，底图常是一张几乎全透明的图，丢掉
    let base: { url: string; size: { width: number; height: number } } | null =
      null;
    let baseSize = parseSize(baseOut?.size);
    if (baseOut) {
      const bytes = await this.generation.seedreamBytes(baseOut);
      if (!baseSize) {
        const meta = await sharp(bytes).metadata();
        baseSize = { width: meta.width ?? 1, height: meta.height ?? 1 };
      }
      if (!(layer.role === 'element' && (await this.assets.isBlank(bytes)))) {
        const stored = await this.assets.storeBuffer(
          bytes,
          'image/png',
          `design-${job.layerId}-base.png`,
        );
        base = { url: stored.url, size: baseSize };
      }
    }
    if (!baseSize) throw new Error('拆层结果缺少底图尺寸');
    const coords = baseSize;

    const stored: StoredPart[] = await Promise.all(
      children.map(async (out, i) => {
        const bytes = await this.generation.seedreamBytes(out);
        const s = await this.assets.storeBuffer(
          bytes,
          'image/png',
          `design-${job.layerId}-part${i + 1}.png`,
        );
        return {
          out,
          url: s.url,
          box: bboxInBase(out.bounding_box, coords),
        };
      }),
    );

    await this.design.mutate(
      job.docId,
      (doc) => {
        const parent = findGenerating(doc, job);
        if (!parent?.generation) return null;
        const index = doc.layers.findIndex((l) => l.id === parent.id);
        const inherit = {
          rotation: parent.rotation,
          opacity: parent.opacity,
          flipX: parent.flipX,
          flipY: parent.flipY,
        };
        const layers: ImageLayer[] = [];
        if (base) {
          layers.push(
            createImageLayer({
              x: parent.x,
              y: parent.y,
              width: parent.width,
              height: parent.height,
              ...inherit,
              name: `${parent.name} · 底图`.slice(0, 80),
              role: parent.role,
              src: base.url,
              generation: {
                prompt: '拆层后的底图',
                channel: BYTEPLUS_CHANNEL,
                model: SEEDREAM_MODEL,
                params: {},
                referenceUrls: [],
                sourceLayerId: parent.id,
              },
            }),
          );
        }
        for (const part of stored) {
          // 没给框的子图层（理论上不会）：铺满被拆图层的框
          const box = part.box
            ? placeDecomposedChild(parent, coords, part.box)
            : {
                x: parent.x,
                y: parent.y,
                width: parent.width,
                height: parent.height,
                rotation: parent.rotation,
              };
          layers.push(
            createImageLayer({
              ...box,
              ...inherit,
              name: (part.out.name || `拆分图层 ${layers.length}`).slice(0, 80),
              role: 'element',
              src: part.url,
              generation: {
                prompt: (part.out.description || part.out.name || '').slice(
                  0,
                  4000,
                ),
                channel: BYTEPLUS_CHANNEL,
                model: SEEDREAM_MODEL,
                params: { background: 'transparent' },
                referenceUrls: [],
                sourceLayerId: parent.id,
              },
            }),
          );
        }
        return [
          { type: 'delete_layers', ids: [parent.id] },
          { type: 'add_layers', layers, index },
        ];
      },
      'system',
    );
    this.logger.log(
      `design 拆层完成 doc=${job.docId} layer=${job.layerId} → ${stored.length} 个子图层${base ? ' + 底图' : ''}`,
    );
  }

  private async current(job: DesignGenJob): Promise<ImageLayer | null> {
    const { document } = await this.design.document(job.docId).catch(() => ({
      document: null,
    }));
    return document ? findGenerating(document, job) : null;
  }
}
