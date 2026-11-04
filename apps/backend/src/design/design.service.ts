import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  applyOps,
  DEFAULT_CANVAS,
  DesignOpError,
  type DesignCanvas,
  type DesignDocument,
  designDocumentSchema,
  type DesignOp,
  emptyDocument,
  GENERATION_OWNED_FIELDS,
  type ImageModelChoice,
  imageModelChoiceSchema,
  type OpSource,
} from '@agent-test/design-schema';
import type { Prisma } from '@prisma/client';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { StreamService } from '../events/stream.service';
import { PrismaService } from '../prisma/prisma.service';

/** CAS 落空（agent 与人、或两个生成结果同时写）时的有界重试次数。 */
const CAS_RETRIES = 8;

export interface DesignSnapshot {
  id: string;
  title: string;
  status: string;
  model: string | null;
  imageModel: ImageModelChoice | null;
  revision: number;
  document: DesignDocument;
  updatedAt: Date;
}

export interface DesignListItem {
  id: string;
  title: string;
  status: string;
  revision: number;
  canvas: DesignCanvas;
  layerCount: number;
  updatedAt: Date;
}

/** 一批 op 被拒的原因：交回调用方（REST 回 400、agent 工具把原话回给模型改参重试）。 */
export class DesignOpRejected extends Error {}

/**
 * 设计稿的单一真相源：所有改动（人 / agent / 生成流水线）都经 mutate 在 revision CAS 下写入，
 * 提交后经 StreamService 广播 design_patch（stream id = docId），前端据此增量更新。
 */
@Injectable()
export class DesignService {
  private readonly logger = new Logger(DesignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    input: { title?: string; canvas?: DesignCanvas },
  ): Promise<DesignSnapshot> {
    const document = emptyDocument(input.canvas ?? DEFAULT_CANVAS);
    const row = await this.prisma.designDoc.create({
      data: {
        tenantId,
        userId,
        title: input.title?.trim() || '未命名设计',
        document: toJson(document),
      },
    });
    return toSnapshot(row);
  }

  async list(tenantId: string, userId: string): Promise<DesignListItem[]> {
    const rows = await this.prisma.designDoc.findMany({
      where: { tenantId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => {
      const doc = parseDocument(r.document);
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        revision: r.revision,
        canvas: doc.canvas,
        layerCount: doc.layers.length,
        updatedAt: r.updatedAt,
      };
    });
  }

  async get(id: string, tenantId: string): Promise<DesignSnapshot> {
    return toSnapshot(await this.findOwned(id, tenantId));
  }

  async updateMeta(
    id: string,
    tenantId: string,
    patch: { title?: string; model?: string; imageModel?: ImageModelChoice },
  ): Promise<DesignSnapshot> {
    await this.findOwned(id, tenantId);
    const row = await this.prisma.designDoc.update({
      where: { id },
      data: {
        ...(patch.title !== undefined
          ? { title: patch.title.trim() || '未命名设计' }
          : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.imageModel !== undefined
          ? { imageModel: toJson(patch.imageModel) }
          : {}),
      },
    });
    return toSnapshot(row);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    await this.findOwned(id, tenantId);
    await this.prisma.designDoc.delete({ where: { id } });
  }

  async findOwned(id: string, tenantId: string) {
    const row = await this.prisma.designDoc.findFirst({
      where: { id, tenantId },
    });
    if (!row) {
      throw new BusinessException(
        ErrorCodes.DESIGN_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /** 当前文档（agent 工具与生成流水线用；不做租户校验，调用方已可信）。 */
  async document(
    id: string,
  ): Promise<{ revision: number; document: DesignDocument }> {
    const row = await this.prisma.designDoc.findUniqueOrThrow({
      where: { id },
      select: { revision: true, document: true },
    });
    return { revision: row.revision, document: parseDocument(row.document) };
  }

  /**
   * 用户 REST 提交的一批 op。额外规则：正在生成的图片图层，图片源相关字段只归生成流水线，
   * 用户改它们一律拒（位置、尺寸照样能拖，见 GENERATION_OWNED_FIELDS）。
   */
  async applyUserOps(
    id: string,
    tenantId: string,
    ops: DesignOp[],
    clientId: string,
  ): Promise<{ revision: number }> {
    await this.findOwned(id, tenantId);
    try {
      return await this.mutate(
        id,
        (doc) => {
          assertUserMayEdit(doc, ops);
          return ops;
        },
        'user',
        clientId,
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
  }

  /**
   * 基于最新文档算出 op 并在 revision CAS 下写入；落空就拿新文档重算（有界重试）。
   * build 返回 null = 无事可做（如生成结果已过期）。op 不合法抛 DesignOpRejected。
   */
  async mutate(
    id: string,
    build: (doc: DesignDocument) => DesignOp[] | null,
    source: OpSource,
    clientId: string = source,
  ): Promise<{ revision: number; document?: DesignDocument }> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const { revision, document } = await this.document(id);
      const ops = build(document);
      if (!ops || ops.length === 0) return { revision };
      let next: DesignDocument;
      try {
        next = applyOps(document, ops);
      } catch (e) {
        if (e instanceof DesignOpError) throw new DesignOpRejected(e.message);
        throw e;
      }
      const cas = await this.prisma.designDoc.updateMany({
        where: { id, revision },
        data: { document: toJson(next), revision: revision + 1 },
      });
      if (cas.count === 0) continue;
      await this.stream.publish(id, {
        type: 'design_patch',
        payload: { ops, revision: revision + 1, source, clientId },
      });
      return { revision: revision + 1, document: next };
    }
    this.logger.warn(`design CAS 连续落空 doc=${id}`);
    throw new BusinessException(
      ErrorCodes.DESIGN_CONFLICT,
      HttpStatus.CONFLICT,
    );
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.prisma.designDoc.update({ where: { id }, data: { status } });
    await this.stream.publish(id, {
      type: 'design_status',
      payload: { status },
    });
  }
}

function assertUserMayEdit(doc: DesignDocument, ops: DesignOp[]): void {
  for (const op of ops) {
    if (op.type !== 'update_layers') continue;
    for (const u of op.updates) {
      const layer = doc.layers.find((l) => l.id === u.id);
      if (layer?.type !== 'image' || layer.status !== 'generating') continue;
      const touched = GENERATION_OWNED_FIELDS.filter((f) => f in u.patch);
      if (touched.length > 0) {
        throw new DesignOpRejected(
          `${ErrorCodes.DESIGN_LAYER_LOCKED.message} (${touched.join(', ')})`,
        );
      }
    }
  }
}

/** 库里的文档 JSON 是我方写入的，但仍过一遍 schema：坏数据在读的时候就暴露，而不是渲染时。 */
export function parseDocument(json: Prisma.JsonValue): DesignDocument {
  return designDocumentSchema.parse(json);
}

/**
 * Prisma 的 Json 入参类型（InputJsonValue）与 zod 推断出的对象类型不兼容（可选字段的 undefined）；
 * 文档已过 schema 校验、只含 JSON 可表示的值，序列化往返即得等价的纯 JSON。
 */
function toJson(
  value: DesignDocument | ImageModelChoice,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toSnapshot(row: {
  id: string;
  title: string;
  status: string;
  model: string | null;
  imageModel: Prisma.JsonValue;
  revision: number;
  document: Prisma.JsonValue;
  updatedAt: Date;
}): DesignSnapshot {
  const image = imageModelChoiceSchema.safeParse(row.imageModel);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    model: row.model,
    imageModel: image.success ? image.data : null,
    revision: row.revision,
    document: parseDocument(row.document),
    updatedAt: row.updatedAt,
  };
}
