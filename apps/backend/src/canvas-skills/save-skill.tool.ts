import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  MAX_INSTRUCTIONS_CHARS,
  type SaveSkillResult,
} from './canvas-skills.service';

/**
 * save_skill：新建或覆盖当前用户的一个画布技能。审批模式下由 interruptOn 拦下等用户确认
 * （见 canvas.agent.factory），全自动模式直接保存。
 * 校验失败把错误原样回给模型——它下一步就能改名、补说明后重试。
 */
export function createSaveSkillTool(
  save: (input: {
    name: string;
    description: string;
    instructions: string;
  }) => Promise<SaveSkillResult>,
) {
  return tool(
    async ({ name, description, instructions }) => {
      // 存库失败（库不可用、并发冲突等）也回一句错误给模型，而不是让异常冒出去拖垮整轮运行
      const r = await save({ name, description, instructions }).catch(
        (err: unknown) => ({
          ok: false as const,
          errors: [
            `保存失败，请稍后重试：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          ],
        }),
      );
      if (!r.ok) return JSON.stringify({ error: r.errors.join('；') });
      return JSON.stringify({
        ok: true,
        name: r.name,
        created: r.created,
        path: `/skills/${r.name}/SKILL.md`,
        usage: `/${r.name} <需求>`,
      });
    },
    {
      name: 'save_skill',
      description:
        '把一个画布技能保存到用户的技能库（同名的用户技能会被覆盖；内置技能不能覆盖）。只在创建或修改技能时调用，写之前先遵循 skills-creator 技能。保存后用户可以用 /<name> 调用它。审批模式下会先请用户确认。',
      schema: z.object({
        name: z
          .string()
          .describe(
            '技能名：小写字母、数字、连字符，首尾为字母或数字，≤64 字符，如 product-teaser-video',
          ),
        description: z
          .string()
          .describe(
            '一段话写清这个技能做什么、什么时候用（含用户可能的说法），≤1024 字符',
          ),
        instructions: z
          .string()
          .describe(
            `SKILL.md 正文（Markdown，不含 frontmatter）：输入、步骤、提示词写法、检查清单。不超过 ${MAX_INSTRUCTIONS_CHARS} 字`,
          ),
      }),
    },
  );
}
