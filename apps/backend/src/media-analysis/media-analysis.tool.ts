import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { MediaAnalysisService } from './media-analysis.service';

/** 工具里等分析完成的上限：用户刚发的视频可能还在分析 */
const TOOL_WAIT_MS = 60_000;

/**
 * get_media_analysis：取某个素材（图片 / 视频 / 音频）的完整理解结果。
 * 「## 附件理解」消息里只有摘要和要点；需要更细的信息（分镜、画面文字、人声转写等）时调它。
 * 还没分析过的素材会现分析（最多等 60 秒）。
 */
export function createMediaAnalysisTool(
  analysis: MediaAnalysisService,
  ctx: { userId: string },
) {
  return tool(
    async ({ versionId }) => {
      const r = await analysis.getForUser(versionId, ctx.userId, TOOL_WAIT_MS);
      if ('error' in r) return JSON.stringify({ error: r.error });
      const row = r.row;
      if (!row || row.status === 'pending') {
        return JSON.stringify({
          versionId,
          status: 'pending',
          note: '还在分析，稍后再取',
        });
      }
      if (row.status === 'failed') {
        return JSON.stringify({
          versionId,
          status: 'failed',
          error: row.error,
          note: '分析失败且不会自动重试：不要再对这个素材调用本工具。按文件名推断它是什么，拿不准就用 ask_user 问用户',
        });
      }
      if (row.status === 'skipped') {
        return JSON.stringify({
          versionId,
          status: 'skipped',
          note: '该素材无需理解（如测试模式的占位素材）',
        });
      }
      return JSON.stringify({
        versionId,
        type: r.type,
        status: 'done',
        analysis: row.detail,
      });
    },
    {
      name: 'get_media_analysis',
      description:
        '取某个素材（用户附件或画布上的图片 / 视频 / 音频）的完整理解结果：主体、构图、风格、画面文字、视频分镜、人声转写等结构化描述。「## 附件理解」消息里只有摘要和要点，需要更细的信息时调用。还没分析过的会现分析（最多等 60 秒）。返回 failed 时不要重复调用——失败结果不会因为重调而改变。',
      schema: z.object({
        versionId: z
          .string()
          .describe('素材的 versionId（附件清单或画布节点上的那个）'),
      }),
    },
  );
}
