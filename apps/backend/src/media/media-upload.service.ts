import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { AigcClient } from '../aigc/aigc.client';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';

/** 媒体资产类型：生成只有 image / video，上传多一个 audio（只当生成素材引用）。 */
export type MediaAssetType = 'image' | 'video' | 'audio';

/** 上传资产的 model 标记：不是模型名，用来在历史里认出"这条是用户传的"（同 CONCAT_MODEL）。 */
export const UPLOAD_MODEL = 'upload';

const MB = 1024 * 1024;

/** 可上传类型 = aigc 上传白名单（POST /files/upload-url 的 content_type 枚举），值为资产类型。 */
export const UPLOAD_CONTENT_TYPES: Record<string, MediaAssetType> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
};

/** 单文件上限：文件经我方后端中转到 GCS，比 aigc 的 500MB 收紧。 */
export const UPLOAD_MAX_BYTES: Record<MediaAssetType, number> = {
  image: 20 * MB,
  video: 200 * MB,
  audio: 50 * MB,
};

/** 一条消息最多带几个附件。 */
export const ATTACHMENTS_MAX = 10;

/** PUT 到 GCS 的硬超时：与预签名地址的有效期（30 分钟）对齐，过期再传也会被拒。 */
const PUT_TIMEOUT_MS = 30 * 60_000;

export interface UploadedAsset {
  generationId: string;
  versionId: string;
  type: MediaAssetType;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

/** 一次上传的文件本体：Content-Type / Content-Length 即类型与字节数，原始文件名另传。 */
export interface UploadFileInput {
  contentType: string;
  size: number;
  filename: string;
  body: Readable;
}

/** 原始文件名只留最后一段（防路径）、去首尾空白、限 255 字；空则给个占位名。 */
export function cleanFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop()?.trim() ?? '';
  return base.slice(0, 255) || 'file';
}

/**
 * 用户文件上传：按 aigc 文档两步走——先申请预签名地址，再把文件 PUT 到 GCS。
 *
 * 第二步由后端流式中转而不是浏览器直传：GCS 桶没配 CORS，浏览器 PUT 会被预检拦下
 * （2026-10-21 实测）。请求体原样 pipe 给 GCS，不落盘、不整块读进内存。
 *
 * 传完落一条 MediaGeneration + MediaVersion（model=upload）。对话附件落 staged：不进资产清单、
 * 不能被引用，随消息发出时才转 done（见 MediaService.commitAttachments）——用户放弃的附件不会
 * 混进模型视野。未发送的 staged 行与 GCS 文件都不清理。
 */
@Injectable()
export class MediaUploadService {
  private readonly logger = new Logger(MediaUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aigc: AigcClient,
  ) {}

  /** Spark 会话的附件上传：校验会话归属后落 staged 资产。 */
  async upload(
    input: UploadFileInput & {
      conversationId: string;
      tenantId: string;
      userId: string;
    },
  ): Promise<UploadedAsset> {
    // 租户隔离同 appendMessage：只能往自己租户、未删除的会话上传
    const conv = await this.prisma.conversation.findFirst({
      where: {
        id: input.conversationId,
        tenantId: input.tenantId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!conv) {
      throw new BusinessException(
        ErrorCodes.CONVERSATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return this.store({ ...input, status: 'staged' });
  }

  /**
   * 校验文件 → 中转到 GCS → 落资产。**不校验归属**：调用方先确认 conversationId
   * （画布传 sessionId，同 media 生成的记账口径）属于当前用户。
   * status：对话附件 staged（随消息发出才转正）；画布上传节点直接 done（传完即挂到节点上可被引用）。
   */
  async store(
    input: UploadFileInput & {
      conversationId: string;
      userId: string;
      status: 'staged' | 'done';
    },
  ): Promise<UploadedAsset> {
    const type = UPLOAD_CONTENT_TYPES[input.contentType];
    if (!type) {
      throw new BusinessException(ErrorCodes.MEDIA_UPLOAD_UNSUPPORTED);
    }
    if (!Number.isInteger(input.size) || input.size <= 0) {
      throw new BusinessException(ErrorCodes.MEDIA_UPLOAD_UNSUPPORTED);
    }
    if (input.size > UPLOAD_MAX_BYTES[type]) {
      throw new BusinessException(
        ErrorCodes.MEDIA_UPLOAD_TOO_LARGE,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const signed = await this.aigc.requestUploadUrl({
      contentType: input.contentType,
      size: input.size,
      filename: input.filename,
    });
    // 流式 body 必须带 duplex:'half'（undici 要求）；DOM 版 RequestInit 类型还没有这个字段，用交叉类型补上
    const init: RequestInit & { duplex: 'half' } = {
      method: signed.method,
      // Content-Length 显式带上：流式 body 默认走 chunked，签名锁死了大小，按字节数声明最稳
      headers: { ...signed.headers, 'Content-Length': String(input.size) },
      body: toWebStream(input.body),
      duplex: 'half',
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    };
    let res: Response;
    try {
      res = await fetch(signed.upload_url, init);
    } catch (e) {
      this.logger.warn(
        `上传中转失败 upload=${signed.upload_id}：${e instanceof Error ? e.message : String(e)}`,
      );
      throw new BusinessException(
        ErrorCodes.MEDIA_UPLOAD_FAILED,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(
        `GCS 拒收 upload=${signed.upload_id} HTTP ${res.status}：${text.slice(0, 200)}`,
      );
      throw new BusinessException(
        ErrorCodes.MEDIA_UPLOAD_FAILED,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const generation = await this.prisma.mediaGeneration.create({
      data: {
        conversationId: input.conversationId,
        userId: input.userId,
        type,
        versions: {
          create: {
            prompt: input.filename,
            model: UPLOAD_MODEL,
            status: input.status,
            url: signed.url,
            params: {
              contentType: input.contentType,
              size: String(input.size),
              aigcUploadId: signed.upload_id,
            },
            completedAt: new Date(),
          },
        },
      },
      include: { versions: true },
    });
    this.logger.log(
      `上传完成 version=${generation.versions[0].id} upload=${signed.upload_id} ${input.contentType} ${input.size}B`,
    );
    return {
      generationId: generation.id,
      versionId: generation.versions[0].id,
      type,
      url: signed.url,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
    };
  }
}

/**
 * Node 可读流 → fetch 能吃的 Web ReadableStream（按需拉取，背压随 GCS 上行速度走）。
 * 不用 Readable.toWeb：它返回 node:stream/web 的类型，与全局 fetch 的 BodyInit 类型对不上。
 */
function toWebStream(src: Readable): ReadableStream<Uint8Array> {
  const it = bytes(src);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      src.destroy();
    },
  });
}

/** 逐块读请求体；express 的 req 产出的都是 Buffer（Uint8Array 子类），借 instanceof 收窄掉 any。 */
async function* bytes(src: Readable): AsyncGenerator<Uint8Array> {
  for await (const chunk of src) {
    if (chunk instanceof Uint8Array) yield chunk;
  }
}
