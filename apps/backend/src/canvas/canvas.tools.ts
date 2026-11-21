import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import {
  createCanvasTools as createSharedCanvasTools,
  type CanvasToolBackend,
} from '@agent-test/agent-core/canvas/canvas-tools';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { MediaService } from '../media/media.service';
import { CanvasService } from './canvas.service';
import type { CanvasApprovalMode } from './canvas.types';

/**
 * 画布工具的工具名 / 入参 / 说明 / 校验与批内排序都在 agent-core（服务端画布 agent 与 desktop 本机 agent
 * 共用，见 packages/agent-core/src/canvas/canvas-tools.ts）；这里只把「怎么落到画布上」接到本进程的
 * CanvasService / MediaService，外加服务端自己的 ask_user。desktop 经 canvas-agent 接口调到同一套服务。
 */

/** 工具运行上下文：worker 闭包注入当前画布会话与可信 userId（不经模型，无注入风险）。 */
export interface CanvasToolContext {
  /** 审批模式：auto 下不会有任何中断，ask_user 因此没人可答（见该工具实现） */
  approvalMode?: CanvasApprovalMode;
  sessionId: string;
  userId: string;
}

/** 业务拒绝转成回给模型的一句话（而不是抛异常废掉一整轮）；其它异常照抛 */
async function orBusinessError<T>(
  run: () => Promise<T>,
): Promise<T | { error: unknown }> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof BusinessException) return { error: e.getResponse() };
    throw e;
  }
}

/**
 * 画布工具的执行端（同进程）：sessionId 来自可信 worker 上下文，免租户校验。
 * desktop 的 canvas-agent 接口在做完租户与运行锁校验后，用同一个实现执行。
 */
export function createCanvasToolBackend(
  canvas: CanvasService,
  media: MediaService,
  ctx: { sessionId: string; userId: string; uploadScope?: string },
): CanvasToolBackend {
  return {
    snapshot: () => canvas.agentSnapshot(ctx.sessionId),
    resolveNodeId: (id) => canvas.resolveNodeId(ctx.sessionId, id),
    applyOp: (op) => canvas.applyOp(ctx.sessionId, 'agent', op),
    // 附件只认用户在这次对话里发的：服务端画布 agent 是本画布会话，desktop 是它自己的会话
    findUploadedAsset: (versionId) =>
      media.findUploadedAsset(
        ctx.uploadScope ?? ctx.sessionId,
        ctx.userId,
        versionId,
      ),
    prepareNodeConfig: (type, req) => media.prepareNodeConfig(type, req),
    createGeneration: ({ type, prompt, referenceVersionIds, config }) =>
      orBusinessError(() =>
        media.createGeneration(
          ctx.sessionId,
          ctx.userId,
          type,
          prompt,
          referenceVersionIds,
          config,
        ),
      ),
    createConcat: (sources) =>
      orBusinessError(() =>
        media.createConcat(ctx.sessionId, ctx.userId, sources),
      ),
    modelCatalog: (type) => media.agentModelCatalog(type, ctx.userId),
  };
}

/** 服务端画布 agent 的全部工具：共享的画布工具 + 本进程的 ask_user。 */
export function createCanvasTools(
  canvas: CanvasService,
  media: MediaService,
  ctx: CanvasToolContext,
): StructuredToolInterface[] {
  const backend = createCanvasToolBackend(canvas, media, ctx);
  const askUser = tool(
    ({ question }: { question: string }) => {
      // 全自动模式下没有 interruptOn，这里不会被拦截、也没有人会回答。
      // 直接把这件事讲明，模型才不会干等或反复追问——返回原问题的话它会以为拿到了答案。
      if (ctx.approvalMode === 'auto') {
        return '当前是全自动模式，没有人会回答。请按你的最佳判断自行决定并继续，不要再提问。';
      }
      // review 模式：实际中断由 interruptOn 拦截；这里的返回值仅在恢复时被用户答案替换。
      return question;
    },
    {
      name: 'ask_user',
      description:
        '向用户提问并等待回答（用于关键澄清：风格方向、数量、是否继续等）。调用会暂停执行直到用户回答。避免对细枝末节频繁提问。',
      schema: z.object({
        question: z.string().describe('要问用户的问题'),
        options: z
          .array(z.string())
          .optional()
          .describe('可选项（供用户快速选择，可空）'),
      }),
    },
  );

  return [...createSharedCanvasTools(() => Promise.resolve(backend)), askUser];
}
