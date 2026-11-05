/**
 * save_skill：把 agent 写好的技能保存进用户的技能库（内置技能 create-skills 的最后一步）。
 * 保存会改变之后所有对话里 agent 的行为，所以始终走 HITL 审批（见 run-service 的 interruptOn）。
 * 参数里不用 z.record（Gemini 的工具 schema 不支持），附带文件用 {path, content} 数组。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SkillStore } from './skill-store';

export const SAVE_SKILL_TOOL = 'save_skill';

export function createSaveSkillTool(skills: SkillStore, onSaved: () => void) {
  return tool(
    async ({ name, description, instructions, files }) => {
      try {
        const info = await skills.saveCustom({ name, description, body: instructions, files });
        onSaved();
        return `已保存技能 ${info.name}。用户以后输入 /${info.name} 加需求即可调用它。`;
      } catch (e) {
        return `保存失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: SAVE_SKILL_TOOL,
      description:
        '把写好的技能保存进用户的技能库（同名的自定义技能会被覆盖）。保存前用户会看到确认卡片；被拒绝就停下按用户意见修改，不要换个名字重试。',
      schema: z.object({
        name: z
          .string()
          .describe('技能名：小写字母、数字、连字符，首尾为字母或数字，≤64 字符，如 weekly-report'),
        description: z
          .string()
          .describe('一段话写清做什么 + 什么时候用（含用户可能的说法），≤1024 字符'),
        instructions: z.string().describe('SKILL.md 正文（Markdown，不含 frontmatter，会自动加上）'),
        files: z
          .array(
            z.object({
              path: z.string().describe('相对技能目录的路径，如 references/template.md 或 scripts/run.py'),
              content: z.string().describe('文件内容（文本）'),
            }),
          )
          .optional()
          .describe('附带文件（可选）：参考资料、模板、脚本'),
      }),
    },
  );
}
