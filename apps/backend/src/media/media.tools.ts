import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { MediaService } from './media.service';

/** 工具运行上下文：worker 闭包注入当前会话与可信 userId（不经模型，无注入风险）。 */
export interface MediaToolContext {
  conversationId: string;
  userId: string;
}

const promptSchema = z.object({
  // 设计 §安全：prompt 上限 2000 字符（schema 层兜底，超长由 zod 直接拒绝）
  prompt: z.string().max(2000).describe('图像/视频生成提示词（已与用户确认）'),
  // 参考图：引用本会话此前生成且已完成的图片版本 id（工具结果里的 versionId）。
  // 图生图可传多张；视频仅取第一张作为首帧。上限 4 张。
  referenceVersionIds: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      '引用本会话此前生成且已完成的图片版本 id（工具结果里的 versionId）；图生图可传多张，视频仅首张作为首帧',
    ),
});

/**
 * 触发与禁区话术（设计 §7）：明确「何时用 / 何时不用」，避免模型未经确认就生成。
 * image 与 video 共用，仅替换媒体词。
 */
function discipline(media: string): string {
  return (
    `当用户**已明确确认**要生成${media}时调用本工具，立即异步发起生成并返回 queued 状态（不等待完成）。\n` +
    `**何时不用**：你刚拟好提示词、但用户尚未确认要生成时，禁止调用——应先把提示词展示给用户、询问是否生成，得到确认后再调用。`
  );
}

/**
 * 构造媒体工具数组，闭包带上会话上下文。
 * handler 调 svc.createGeneration（立即入队，不等生成），返回 { generationId, versionId, status:'queued' } JSON
 * ——前端用 generationId 做卡片锚点，状态后续经 media_update 事件 + REST 查询刷新。
 */
export function createMediaTools(svc: MediaService, ctx: MediaToolContext) {
  const generateImageTool = tool(
    async ({
      prompt,
      referenceVersionIds,
    }: {
      prompt: string;
      referenceVersionIds?: string[];
    }) => {
      try {
        const r = await svc.createGeneration(
          ctx.conversationId,
          ctx.userId,
          'image',
          prompt,
          referenceVersionIds,
        );
        return JSON.stringify({ ...r, status: 'queued' });
      } catch (e) {
        if (e instanceof BusinessException) {
          return JSON.stringify({
            error: e.getResponse(),
            hint: '请改用本会话媒体资产清单或工具结果中的真实 versionId 后重试',
          });
        }
        throw e;
      }
    },
    {
      name: 'generate_image',
      description:
        `根据提示词生成图像（异步）。可用 referenceVersionIds 引用此前生成的图片做图生图（工具结果里的 versionId 即引用键）。` +
        discipline('图像'),
      schema: promptSchema,
    },
  );

  const generateVideoTool = tool(
    async ({
      prompt,
      referenceVersionIds,
    }: {
      prompt: string;
      referenceVersionIds?: string[];
    }) => {
      try {
        const r = await svc.createGeneration(
          ctx.conversationId,
          ctx.userId,
          'video',
          prompt,
          referenceVersionIds,
        );
        return JSON.stringify({ ...r, status: 'queued' });
      } catch (e) {
        if (e instanceof BusinessException) {
          return JSON.stringify({
            error: e.getResponse(),
            hint: '请改用本会话媒体资产清单或工具结果中的真实 versionId 后重试',
          });
        }
        throw e;
      }
    },
    {
      name: 'generate_video',
      description:
        `根据提示词生成视频（异步，长任务）。可用 referenceVersionIds 引用此前生成的图片作为视频首帧（仅取第一张）。` +
        discipline('视频'),
      schema: promptSchema,
    },
  );

  return [generateImageTool, generateVideoTool];
}
