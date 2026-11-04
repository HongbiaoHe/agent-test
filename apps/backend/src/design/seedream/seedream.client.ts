import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

/**
 * 直连 BytePlus ModelArk 的 Seedream 5.0 Pro（POST {base}/images/generations，同步返回）。
 * 文档：https://docs.byteplus.com/en/docs/modelark/image-generation-api
 *
 * env 懒读（同 AigcClient）：没配 BYTEPLUS_ARK_API_KEY 时 isConfigured()=false，设计模块整体降级
 * （下拉不出现 Seedream、agent 不挂拆层工具），后端照常启动。
 */

const DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const DEFAULT_MODEL = 'dola-seedream-5-0-pro-260628';
/** 同步接口：拆层 16 层可能很久，给足 10 分钟 */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

const outputSchema = z.object({
  url: z.string().optional(),
  b64_json: z.string().optional(),
  /** <width>x<height> */
  size: z.string().optional(),
  output_format: z.string().optional(),
  /** 拆层：底图固定 0，图层从 1 递增，越大越靠上 */
  z_index: z.number().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  /** 拆层：图层在**输出底图坐标系**里的框 [left, top, right, bottom]；底图本身不返回 */
  bounding_box: z
    .object({
      absolute: z.array(z.number()).length(4).optional(),
      normalized: z.array(z.number()).length(4).optional(),
    })
    .optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});
export type SeedreamOutput = z.infer<typeof outputSchema>;

const responseSchema = z.object({
  data: z.array(outputSchema).optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

export interface SeedreamGenerateInput {
  prompt: string;
  /** URL 或 data:image/<fmt>;base64,...；transparent 模式下必须恰好 1 张带 alpha 的图 */
  images?: string[];
  /** 像素宽高（如 2048x1536）或档位（1K / 1.5K / 2K） */
  size: string;
  /** transparent 只支持「1 张带 alpha 的输入图 → 图生图」 */
  background?: 'transparent' | 'opaque';
}

export interface SeedreamDecomposeInput {
  /** 要拆的图：png/jpeg，总像素 ≥ 512×512 */
  image: string;
  /** 可选：指定要拆出哪些元素；不给则模型自动识别主要元素 */
  prompt?: string;
}

export class SeedreamError extends Error {}

@Injectable()
export class SeedreamClient {
  private readonly logger = new Logger(SeedreamClient.name);

  isConfigured(): boolean {
    return Boolean(process.env.BYTEPLUS_ARK_API_KEY?.trim());
  }

  /** 文生图 / 图生图，返回一张图。 */
  async generate(input: SeedreamGenerateInput): Promise<SeedreamOutput> {
    const data = await this.call({
      prompt: input.prompt,
      ...(input.images?.length
        ? { image: input.images.length === 1 ? input.images[0] : input.images }
        : {}),
      size: input.size,
      output_format: 'png',
      ...(input.background ? { background: input.background } : {}),
    });
    const first = data[0];
    if (!first) throw new SeedreamError('Seedream 未返回图片');
    return first;
  }

  /** 拆层：返回底图（z_index 0）+ 最多 16 个透明 PNG 图层，按 z_index 升序。 */
  async decompose(input: SeedreamDecomposeInput): Promise<SeedreamOutput[]> {
    const data = await this.call({
      ...(input.prompt ? { prompt: input.prompt } : {}),
      image: input.image,
      layer_decomposition: true,
      size: 'auto',
      // 底图也要 png：被拆的图层可能本身就是透明的
      output_format: 'png',
    });
    return [...data].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  }

  private async call(body: Record<string, unknown>): Promise<SeedreamOutput[]> {
    const key = process.env.BYTEPLUS_ARK_API_KEY?.trim();
    if (!key) throw new SeedreamError('未配置 BYTEPLUS_ARK_API_KEY');
    const base = (
      process.env.BYTEPLUS_ARK_BASE_URL?.trim() || DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const model = process.env.BYTEPLUS_SEEDREAM_MODEL?.trim() || DEFAULT_MODEL;
    const started = Date.now();
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        ...body,
        response_format: 'url',
        watermark: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON（网关错误页等）：下面按 HTTP 状态报错
    }
    const parsed = responseSchema.safeParse(json);
    if (!res.ok || !parsed.success || parsed.data.error) {
      const err = parsed.success ? parsed.data.error : undefined;
      const reason =
        [err?.code, err?.message].filter(Boolean).join(': ') ||
        `HTTP ${res.status} ${text.slice(0, 300)}`;
      throw new SeedreamError(`Seedream 请求失败：${reason}`);
    }
    const data = parsed.data.data ?? [];
    const failed = data.find((d) => d.error);
    if (failed?.error) {
      throw new SeedreamError(
        `Seedream 生成失败：${[failed.error.code, failed.error.message].filter(Boolean).join(': ')}`,
      );
    }
    this.logger.log(
      `Seedream ${body.layer_decomposition ? '拆层' : '生成'}完成 ${data.length} 张，用时 ${Math.round((Date.now() - started) / 1000)}s`,
    );
    return data;
  }
}

const RESOLUTION_SIDE: Record<string, number> = {
  '1K': 1024,
  '1.5K': 1536,
  '2K': 2048,
};
/** 文档：像素宽高的总像素须在 [1280×720, 2048×2048×1.1025] 之间，宽高比 [1/16, 16] */
const MIN_PIXELS = 1280 * 720;
const MAX_PIXELS = Math.floor(2048 * 2048 * 1.1025);

/** 按目标框的宽高比 + 画质档位，算一个合法的像素尺寸（宽高取 8 的倍数）。 */
export function seedreamSize(
  width: number,
  height: number,
  resolution: string,
): string {
  const side = RESOLUTION_SIDE[resolution] ?? 2048;
  const ratio = Math.min(16, Math.max(1 / 16, width / height));
  const area = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, side * side));
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;
  const snap = (n: number) => Math.max(8, Math.round(n / 8) * 8);
  w = snap(w);
  h = snap(h);
  // 取整后可能越界：向内 / 向外各挪一格
  while (w * h > MAX_PIXELS) {
    if (w >= h) w -= 8;
    else h -= 8;
  }
  while (w * h < MIN_PIXELS) {
    if (w <= h) w += 8;
    else h += 8;
  }
  return `${w}x${h}`;
}

export function parseSize(
  size: string | undefined,
): { width: number; height: number } | null {
  const m = size?.match(/^(\d+)x(\d+)$/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
