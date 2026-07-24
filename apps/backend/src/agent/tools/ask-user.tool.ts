import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 向用户提问的 HITL 工具（配合 agent.factory 的 interruptOn 使用）。
 *
 * 决策语义（设计见 docs/superpowers/specs/2026-07-24-ask-user-tool-design.md）：
 * - edit：前端把用户的选择/自定义答案写进 args.answers 后按原工具执行，
 *   本函数返回这些答案并标记 auto:false。
 *   （本项目 langchain 1.4.2 的 HITL 运行时只支持 approve/edit/reject，
 *   官方新版的 respond 决策不可用，故用 edit 承载「用户答案」。）
 * - approve：采纳建议答案——按原参数执行，返回 suggested 并标记 auto:true。
 *   前端 60s 倒计时到点与服务端兜底超时（agent.processor）都走 approve。
 */
const questionSchema = z.object({
  question: z.string().describe('The complete question to ask the user.'),
  header: z
    .string()
    .describe('Short label (2-6 chars) shown as the question group title.'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Allow selecting multiple options.'),
  // ⚠️ 结构约束只留 min：HITL 中断发生在 zod 校验**之前**（面板已渲染、用户已作答），
  // max 超限只会炸在 approve/edit 续跑的 tool.invoke 上（Gemini 实测会无视 maxItems 给 7 个选项）。
  // 数量上限交给 description 引导 + 前端渲染兼容任意个数。
  options: z
    .array(
      z.object({
        label: z.string().describe('Display text of the choice.'),
        description: z
          .string()
          .optional()
          .describe('What this choice means or implies.'),
      }),
    )
    .min(2),
  suggested: z
    .array(z.string())
    .min(1)
    .describe(
      'Recommended answer(s); every item must be an option label. Exactly 1 for single-select. Adopted automatically if the user does not respond in time.',
    ),
});

const askUserSchema = z.object({
  questions: z.array(questionSchema).min(1),
  answers: z
    .array(
      z.object({
        header: z.string(),
        selected: z.array(z.string()),
      }),
    )
    .optional()
    .describe(
      'INTERNAL — never set this yourself. Filled by the user answer panel.',
    ),
});

/**
 * suggested 归一化（同上原因不能用 refine 硬校验——只会炸在续跑）：
 * 过滤到合法 option label；全无效回退首选项；单选只取第一个。
 */
function normalizeSuggested(
  question: z.infer<typeof questionSchema>,
): string[] {
  const labels = new Set(question.options.map((o) => o.label));
  const valid = question.suggested.filter((s) => labels.has(s));
  const picks = valid.length > 0 ? valid : [question.options[0].label];
  return question.multiSelect ? picks : [picks[0]];
}

export const askUserTool = tool(
  ({ questions, answers }: z.infer<typeof askUserSchema>) => {
    // edit 路径：前端已把用户答案写进 answers → 原样返回（auto:false）
    if (answers && answers.length > 0) {
      return JSON.stringify({
        answers: answers.map((a) => ({ ...a, auto: false })),
      });
    }
    // approve 路径（含超时自动采纳）：返回归一化后的建议答案（auto:true）
    return JSON.stringify({
      answers: questions.map((question) => ({
        header: question.header,
        question: question.question,
        selected: normalizeSuggested(question),
        auto: true,
      })),
    });
  },
  {
    name: 'ask_user',
    description:
      'Ask the user 1-4 clarifying questions when a key decision cannot be made from available context. ' +
      'Each question provides 2-4 options and a suggested answer (must be option labels). ' +
      'The user may pick options, or reply with a custom answer instead. ' +
      'If the user does not respond in time, the suggested answers are adopted automatically. ' +
      'Do not use for questions you can answer yourself from the conversation or workspace.',
    schema: askUserSchema,
  },
);
