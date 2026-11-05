import {
  createMediaTools as createSharedMediaTools,
  mediaParamsSchema,
} from '@agent-test/agent-core/media/media-tools';
import { BusinessException } from '../common/errors/business.exception';
import { MediaService } from './media.service';

/**
 * 媒体工具的工具名 / 入参 / 说明 / 结果格式在 agent-core（Web 与 desktop 共用，见
 * packages/agent-core/src/media/media-tools.ts）；这里只把「怎么生成」接到本进程的 MediaService。
 * desktop 经 /media-api 接口（media-api.controller.ts）调到同一个 MediaService。
 */
export { mediaParamsSchema };

/** 工具运行上下文：worker 闭包注入当前会话与可信 userId（不经模型，无注入风险）。 */
export interface MediaToolContext {
  conversationId: string;
  userId: string;
}

export function createMediaTools(svc: MediaService, ctx: MediaToolContext) {
  return createSharedMediaTools({
    listModels: (type) => svc.agentModelCatalog(type, ctx.userId),
    generate: (type, input) =>
      svc.createAgentGenerations(ctx.conversationId, ctx.userId, type, input),
    cloneVoice: (input) =>
      svc.createVoiceClone(ctx.conversationId, ctx.userId, input),
    // 归属 / 不存在等业务错误：回给模型改正（同重构前的 BusinessException 分支）
    userError: (e) => (e instanceof BusinessException ? e.getResponse() : null),
  });
}
