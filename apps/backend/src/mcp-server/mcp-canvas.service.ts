import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createCanvasTools as createSharedCanvasTools } from '@agent-test/agent-core/canvas/canvas-tools';
import {
  buildAgentCanvasContext,
  MCP_LOCK_HOLDER_PREFIX,
  shortNodeId,
} from '@agent-test/canvas-schema';
import { createCanvasToolBackend } from '../canvas/canvas.tools';
import { CanvasService } from '../canvas/canvas.service';
import { signAssetToken } from '../media/media-asset-token';
import {
  UPLOAD_CONTENT_TYPES,
  UPLOAD_MAX_BYTES,
  cleanFilename,
  MediaUploadService,
} from '../media/media-upload.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { toPublicError } from './mcp-errors';
import type { McpPrincipal } from './mcp-grant.service';
import { canvasUrl, mcpPublicOrigin } from './mcp-server.config';
import { safeFetch } from './safe-fetch';

/** 生成任务还没结束的状态（其余 done / failed / paused 都算已有结论） */
const RUNNING = new Set(['queued', 'generating']);
const WAIT_POLL_MS = 1500;
/**
 * wait_for_generations 单次最多等几秒：要短于主站 Next rewrites 反代的 30 秒超时
 * （next/dist/server/lib/router-utils/proxy-request.js 的 proxyTimeout 默认值），否则请求会被反代掐断成 500。
 */
export const WAIT_MAX_S = 25;
export const WAIT_DEFAULT_S = 20;
/** timeoutSeconds 参数接受到多少（超过 WAIT_MAX_S 的按 WAIT_MAX_S 等）：之前的上限是 60，照旧传 60 的客户端不该被参数校验拒掉 */
export const WAIT_ACCEPT_MAX_S = 60;

export interface GenerationState {
  generationId: string;
  status: string;
  versionId: string | null;
  /** 产物地址：CDN 直链，或本地产物的签名公开链接；未完成为 null */
  url: string | null;
  mock: boolean;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MCP 工具背后的画布操作。租户校验都在这里做（工具层拿到的 canvasId 来自模型，不可信）：
 * 读走 assertAccess，写先 acquireRunLock（它自带归属校验，且同时就是隐式锁）。
 */
@Injectable()
export class McpCanvasService {
  constructor(
    private readonly canvas: CanvasService,
    private readonly media: MediaService,
    private readonly uploads: MediaUploadService,
    private readonly prisma: PrismaService,
  ) {}

  async listCanvases(p: McpPrincipal, cursor?: string) {
    const page = await this.canvas.list(p.tenantId, { cursor, limit: 30 });
    return {
      ...page,
      items: page.items.map((c) => ({ ...c, canvasUrl: canvasUrl(c.id) })),
    };
  }

  async createCanvas(p: McpPrincipal, title?: string) {
    const { sessionId } = await this.canvas.create(
      undefined,
      title,
      p.tenantId,
      p.userId,
    );
    return { canvasId: sessionId, canvasUrl: canvasUrl(sessionId) };
  }

  /** 读操作的归属校验（不存在 / 不属于本租户 → CANVAS_NOT_FOUND） */
  assertAccess(p: McpPrincipal, canvasId: string): Promise<void> {
    return this.canvas.assertAccess(canvasId, p.tenantId);
  }

  /**
   * 隐式运行锁：每次写工具调用都申请 / 续期（holder = mcp:<授权 id>，label = agent 名（如 Claude Code），认不出时用授权名），60 秒没有新写入自动过期。
   * 服务端画布 agent 在跑、或别的端持锁 → CANVAS_BUSY。
   */
  async lockForWrite(p: McpPrincipal, canvasId: string): Promise<void> {
    await this.canvas.acquireRunLock(
      canvasId,
      p.tenantId,
      `${MCP_LOCK_HOLDER_PREFIX}${p.grantId}`,
      p.agent ?? p.name,
    );
  }

  /** 共享画布工具（agent-core），执行端绑定这块画布与本授权的用户 */
  sharedTools(p: McpPrincipal, canvasId: string): StructuredToolInterface[] {
    const backend = createCanvasToolBackend(this.canvas, this.media, {
      sessionId: canvasId,
      userId: p.userId,
    });
    // 批量工具会把单项失败的 message 原样写进结果（add_nodes 的 results[i].error），
    // 这里先把非业务异常换成通用说法，免得 Prisma 报错原文带着源码位置回给第三方
    const applyOp: typeof backend.applyOp = (op) =>
      backend.applyOp(op).catch((e: unknown) => {
        throw toPublicError(e);
      });
    return createSharedCanvasTools(() =>
      Promise.resolve({ ...backend, applyOp }),
    );
  }

  /** 画布状态：与画布 agent 每轮注入的同一份文本，外加生成 / 上传节点的产物明细 */
  async getCanvas(p: McpPrincipal, canvasId: string) {
    await this.canvas.assertAccess(canvasId, p.tenantId);
    const snap = await this.canvas.agentSnapshot(canvasId);
    // 「加入对话」圈选是画布 agent 对话里的关注范围，外部 agent 看整块画布
    const text = buildAgentCanvasContext({ ...snap, focusNodeIds: [] });
    const genIds = snap.nodes
      .map((n) => n.mediaGenerationId)
      .filter((id): id is string => !!id);
    const states = await this.generationStates(canvasId, genIds);
    const media = snap.nodes
      .filter((n) => n.mediaGenerationId)
      .map((n) => ({
        nodeId: shortNodeId(n.id),
        type: n.type,
        ...states.get(n.mediaGenerationId ?? ''),
      }));
    return {
      canvasId,
      canvasUrl: canvasUrl(canvasId),
      title: snap.title,
      revision: snap.revision,
      runLock: snap.runLock,
      state: text,
      media,
    };
  }

  /** 阻塞到这些生成都有结论或超时；超时就回当前状态，让模型再调一次 */
  async waitForGenerations(
    p: McpPrincipal,
    canvasId: string,
    generationIds: string[],
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; generations: GenerationState[] }> {
    await this.canvas.assertAccess(canvasId, p.tenantId);
    const deadline = Date.now() + Math.min(timeoutS, WAIT_MAX_S) * 1000;
    for (;;) {
      const states = await this.generationStates(canvasId, generationIds);
      const list = generationIds.map(
        (id): GenerationState =>
          states.get(id) ?? {
            generationId: id,
            status: 'not_found',
            versionId: null,
            url: null,
            mock: false,
            error: '这块画布上没有这个生成任务',
          },
      );
      const done = list.every((g) => !RUNNING.has(g.status));
      if (done || Date.now() >= deadline || signal?.aborted) {
        return { done, generations: list };
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * 拉取公网 URL 落成这块画布的上传素材（同用户在卡片上传文件，status=done 可直接引用），
   * 返回的 versionId 交给 add_node 建上传节点。
   */
  async importAsset(
    p: McpPrincipal,
    canvasId: string,
    url: string,
    filename?: string,
    signal?: AbortSignal,
  ) {
    await this.canvas.assertAccess(canvasId, p.tenantId);
    const file = await safeFetch(url, {
      maxBytesFor: (ct) => {
        const type = UPLOAD_CONTENT_TYPES[ct];
        return type ? UPLOAD_MAX_BYTES[type] : null;
      },
      signal,
    });
    // 下载刚好在取消之后完成：不再落库，免得留下一份调用方以为已经取消的素材
    signal?.throwIfAborted();
    const asset = await this.uploads.store({
      contentType: file.contentType,
      size: file.body.length,
      filename: cleanFilename(filename ?? file.filename),
      body: Readable.from(file.body),
      conversationId: canvasId,
      userId: p.userId,
      status: 'done',
    });
    return {
      versionId: asset.versionId,
      type: asset.type,
      filename: asset.filename,
      uploadNodeType: `${asset.type}_upload`,
    };
  }

  /** 每个生成任务最新一版的状态与产物地址（只认这块画布名下的任务） */
  private async generationStates(
    canvasId: string,
    generationIds: string[],
  ): Promise<Map<string, GenerationState>> {
    const map = new Map<string, GenerationState>();
    if (generationIds.length === 0) return map;
    const versions = await this.prisma.mediaVersion.findMany({
      where: {
        generationId: { in: generationIds },
        generation: { conversationId: canvasId },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        generationId: true,
        status: true,
        url: true,
        filePath: true,
        mock: true,
        error: true,
      },
    });
    for (const v of versions) {
      if (map.has(v.generationId)) continue;
      map.set(v.generationId, {
        generationId: v.generationId,
        status: v.status,
        versionId: v.id,
        url: v.status === 'done' ? assetUrl(v) : null,
        mock: v.mock,
        error: v.error,
      });
    }
    return map;
  }
}

/** CDN 产物直接给；本地产物（拼接 / 模拟生成）给签名公开链接，经主站 /api-backend 反代到后端 */
function assetUrl(v: {
  id: string;
  url: string | null;
  filePath: string | null;
}): string | null {
  if (v.url) return v.url;
  if (!v.filePath) return null;
  return `${mcpPublicOrigin()}/api-backend/media/public/assets/${v.filePath}?token=${signAssetToken(v.id)}`;
}
