import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { AigcClient } from '../aigc/aigc.client';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';

const MB = 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * MB;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FETCH_TIMEOUT_MS = 60_000;
const PUT_TIMEOUT_MS = 5 * 60_000;

export interface StoredImage {
  url: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/**
 * 设计模块的图片存取：用户上传、生成结果裁边后都转存到 aigc 的 CDN（同 MediaUploadService 的两步：
 * 申请预签名地址 → 后端 PUT 到 GCS；桶没配 CORS，浏览器不能直传）。
 * 不落 MediaGeneration 行——设计稿里图层的 src 就是 CDN 地址，文档本身即记录。
 */
@Injectable()
export class DesignAssetsService {
  private readonly logger = new Logger(DesignAssetsService.name);

  constructor(private readonly aigc: AigcClient) {}

  /** 用户上传：读进内存（≤20MB 的图片），量出尺寸与是否带 alpha 后转存。 */
  async storeUpload(input: {
    body: Readable;
    contentType: string;
    size: number;
    filename: string;
  }): Promise<StoredImage> {
    if (
      !ALLOWED_TYPES.has(input.contentType) ||
      !Number.isInteger(input.size) ||
      input.size <= 0 ||
      input.size > MAX_UPLOAD_BYTES
    ) {
      throw new BusinessException(ErrorCodes.DESIGN_UPLOAD_INVALID);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of input.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > MAX_UPLOAD_BYTES) {
        throw new BusinessException(ErrorCodes.DESIGN_UPLOAD_INVALID);
      }
      chunks.push(buf);
    }
    return this.storeBuffer(
      Buffer.concat(chunks),
      input.contentType,
      input.filename,
    );
  }

  async storeBuffer(
    bytes: Buffer,
    contentType: string,
    filename: string,
  ): Promise<StoredImage> {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height) {
      throw new BusinessException(ErrorCodes.DESIGN_UPLOAD_INVALID);
    }
    const signed = await this.aigc.requestUploadUrl({
      contentType,
      size: bytes.length,
      filename,
    });
    const res = await fetch(signed.upload_url, {
      method: signed.method,
      headers: { ...signed.headers, 'Content-Length': String(bytes.length) },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(
        `GCS 拒收 ${filename} HTTP ${res.status}：${text.slice(0, 200)}`,
      );
      throw new BusinessException(
        ErrorCodes.MEDIA_UPLOAD_FAILED,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      url: signed.url,
      width: meta.width,
      height: meta.height,
      hasAlpha: Boolean(meta.hasAlpha),
    };
  }

  async fetchBytes(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 透明元素图：按 alpha 通道裁掉四周的透明边（gpt-image 只有 6 种画幅，元素四周必然留白），
   * 阈值取低（只裁几乎全透明的像素），抗锯齿的半透明边缘保留。不带 alpha 的图原样返回。
   */
  async trimTransparent(bytes: Buffer): Promise<Buffer> {
    const meta = await sharp(bytes).metadata();
    if (!meta.hasAlpha) return bytes;
    try {
      return await sharp(bytes)
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 4 })
        .png()
        .toBuffer();
    } catch (e) {
      // 整张全透明时 sharp 会报「无可裁内容」：原样返回，由上层当成一张空图处理
      this.logger.warn(
        `裁透明边失败，原样使用：${e instanceof Error ? e.message : String(e)}`,
      );
      return bytes;
    }
  }

  /**
   * 交给 Seedream 的输入图（data URL）：长边限 maxSide；总像素不足 minPixels 就放大（拆层要求 ≥512×512）。
   * alpha=true 强制带 alpha 通道的 PNG（透明模式要求输入有 alpha）；否则原图有 alpha 用 PNG、没有用 JPEG。
   */
  async toSeedreamInput(
    bytes: Buffer,
    opts: { alpha: boolean; maxSide?: number; minPixels?: number },
  ): Promise<string> {
    const meta = await sharp(bytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) throw new Error('无法读取图片尺寸');
    const maxSide = opts.maxSide ?? 2048;
    let scale = Math.min(1, maxSide / Math.max(w, h));
    const minPixels = opts.minPixels ?? 0;
    if (w * h * scale * scale < minPixels) {
      scale = Math.sqrt(minPixels / (w * h)) * 1.01;
    }
    let img = sharp(bytes);
    if (scale !== 1) {
      img = img.resize(Math.ceil(w * scale), Math.ceil(h * scale), {
        fit: 'fill',
      });
    }
    if (opts.alpha || meta.hasAlpha) {
      const png = await img.ensureAlpha().png().toBuffer();
      return `data:image/png;base64,${png.toString('base64')}`;
    }
    const jpg = await img.jpeg({ quality: 92 }).toBuffer();
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  }

  /** 全透明的空白 PNG（Seedream 透明模式「无中生有」时的唯一输入），size 形如 1024x1024。 */
  async blankPngDataUrl(size: string): Promise<string> {
    const m = size.match(/^(\d+)x(\d+)$/);
    const width = m ? Number(m[1]) : 1024;
    const height = m ? Number(m[2]) : 1024;
    const png = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  }

  /** 几乎全透明（alpha 最大值很低）：拆层后元素图层的底图常是这样，留着没意义。 */
  async isBlank(bytes: Buffer): Promise<boolean> {
    const { channels } = await sharp(bytes).stats();
    const alpha = channels[3];
    return Boolean(alpha && alpha.max < 8);
  }

  /** 给多模态模型看的图：长边缩到 maxSide、转 JPEG/PNG 的 base64（透明图保留 PNG）。 */
  async toModelImage(
    url: string,
    maxSide = 1536,
  ): Promise<{ mimeType: string; data: string }> {
    const bytes = await this.fetchBytes(url);
    const img = sharp(bytes).resize({
      width: maxSide,
      height: maxSide,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const meta = await sharp(bytes).metadata();
    if (meta.hasAlpha) {
      return {
        mimeType: 'image/png',
        data: (await img.png().toBuffer()).toString('base64'),
      };
    }
    return {
      mimeType: 'image/jpeg',
      data: (await img.jpeg({ quality: 85 }).toBuffer()).toString('base64'),
    };
  }
}
