import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { parseCommand } from '../commands/parse-command';
import { SKILL_READ_LIMIT } from '../modes/prompt-fragments';
import { absolutizeRefPaths } from '../skills/skill-files';

/**
 * 每轮开跑前算出、注入系统提示的两段运行期文本（backend 与 desktop 共用）。
 */

const todosSchema = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.string() })),
});

/**
 * 「当前任务计划」：由最近一条 plan_update 的内容生成，经 runtime context 交给 activePlanProvider
 * 接到系统提示末尾。没有计划（首轮 / 已清空）返回空串，让模型自由完成首次拆解。
 *
 * 为什么需要它：write_todos 的 plan_update / tool 消息不在历史重放范围内，todoListMiddleware 也只注入
 * 「如何用 write_todos」、从不注入当前列表，且文案鼓励「随时重订计划」——不回注既有计划，模型每轮都会
 * 整表重写 todos、把没执行完的步骤冲掉。措辞只锁「整表替换 / 删改重排」，仍允许末尾追加新子任务。
 */
export function buildActivePlan(lastPlanContent: unknown): string {
  const parsed = todosSchema.safeParse(lastPlanContent);
  if (!parsed.success || parsed.data.todos.length === 0) return '';
  const lines = parsed.data.todos
    .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
    .join('\n');
  return (
    `## 当前任务计划（已存在，继续执行，请勿重新拆解）\n${lines}\n\n` +
    `本会话已有上面这份既定计划，请在它的基础上继续：\n` +
    `- 保留已有步骤的文本与顺序不变，逐步用 write_todos 推进状态（pending → in_progress → completed）；\n` +
    `- 开始某一步前标记为 in_progress，完成后立即标记为 completed；\n` +
    `- 不要把整张列表替换成新的，也不要删除、改写或重排已有步骤；仅当确实发现新子任务时，可在末尾追加。`
  );
}

/** read_file 不传 limit 时 deepagents 的默认行数（deepagents 1.10.2 read_file schema `.default(100)`） */
const READ_FILE_DEFAULT_LIMIT = 100;

const readFileArgs = z.object({
  file_path: z.string(),
  offset: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

/**
 * 重放的上下文里是否已有这份 SKILL.md 的**完整**读取：read_file 调用与它的结果都在（工具调用对按 id 重放），
 * 从第 0 行开始，且 limit 覆盖全文（没传 limit 按默认 100 行算——更长的文件那次只读到一部分）。
 */
function fullyReadInContext(
  context: readonly BaseMessage[],
  name: string,
  lineCount: number,
): boolean {
  const results = new Set(
    context.filter((m) => ToolMessage.isInstance(m)).map((m) => m.tool_call_id),
  );
  return context.some(
    (m) =>
      AIMessage.isInstance(m) &&
      (m.tool_calls ?? []).some((c) => {
        if (c.name !== 'read_file' || !c.id || !results.has(c.id)) return false;
        const args = readFileArgs.safeParse(c.args);
        if (
          !args.success ||
          !args.data.file_path.endsWith(`/${name}/SKILL.md`)
        ) {
          return false;
        }
        return (
          (args.data.offset ?? 0) === 0 &&
          (args.data.limit ?? READ_FILE_DEFAULT_LIMIT) >= lineCount
        );
      }),
  );
}

/**
 * 之前轮次已用 `/技能名` 激活过某技能、而那次读到的 SKILL.md 已不在本轮上下文里时，把全文注入系统提示，
 * 并要求不要再 read_file 读它。
 *
 * 工具调用对现在会跨轮重放（见 history.ts），上一轮完整读过的 SKILL.md 本来就在上下文里，再注入就是重复
 * （每轮多出整份技能文件的 token）。只在这几种情况注入：那次读取已被压缩进摘要（不再重放）、只读了一部分
 * （没传够 limit 被截断）、或根本没读。context 传本轮喂给模型的消息（压缩后的）。
 * 本轮才首次发起的 /command 不注入，交给平台片段的「先 read_file SKILL.md」规则完成首次加载。
 *
 * skillMd：按技能名取 SKILL.md；不在当前模式技能集内的返回 null（模式外的 /技能名 当普通文本）。
 * SKILL.md 经 absolutizeRefPaths 改写相对引用，注入后正文里的 references 路径仍能命中。
 */
export async function buildSkillPrompt(
  userTexts: readonly string[],
  skillMd: (name: string) => string | null | Promise<string | null>,
  skillsDir: string,
  context: readonly BaseMessage[] = [],
): Promise<string> {
  if (userTexts.length === 0) return '';
  const currentIndex = userTexts.length - 1;
  let active: { name: string; md: string; index: number } | null = null;
  for (let i = 0; i < userTexts.length; i++) {
    const cmd = parseCommand(userTexts[i]);
    if (!cmd) continue;
    const md = await skillMd(cmd.name);
    if (md) active = { name: cmd.name, md, index: i };
  }
  // 没有激活任何技能，或激活就发生在本轮（首次加载，交给 read_file）→ 不注入
  if (!active || active.index === currentIndex) return '';
  if (fullyReadInContext(context, active.name, active.md.split('\n').length)) {
    return '';
  }
  const content = absolutizeRefPaths(active.name, active.md, skillsDir);
  return (
    `\n\n## 已加载技能：${active.name}（SKILL.md 已提供，请勿重复读取）\n` +
    `本会话在之前的轮次已通过 \`/${active.name}\` 激活该技能，其 SKILL.md 全文见下。` +
    `请直接据此继续，**不要再 read_file 读取 \`${skillsDir}/${active.name}/SKILL.md\`**；` +
    `仅当需要其引用的 references/ 子技能等子文件时，才按需 read_file 那些子文件（传 \`limit=${SKILL_READ_LIMIT}\`）。\n\n` +
    `<skill name="${active.name}">\n${content}\n</skill>`
  );
}
