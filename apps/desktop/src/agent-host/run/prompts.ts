/**
 * desktop 的宿主提示词（通用段在 agent-core system-prompt.ts）与两段运行期注入：
 * 计划延续（activePlan）、已激活技能的 SKILL.md。后两者逻辑对照 backend worker 的
 * buildActivePlan / buildSkillPrompt（apps/backend/src/worker/agent.processor.ts）。
 */
import { absolutizeRefPaths } from '@agent-test/agent-core/skills/skill-files';
import { parseCommand } from '@agent-test/agent-core/commands/parse-command';
import { MEDIA_GENERATION_PROMPT } from '@agent-test/agent-core/media/media-prompt';
import { z } from 'zod';
import type { WorkspacePermission } from '../../shared/workspace';

/** 接在通用段之后的 desktop 专属段落 */
export const DESKTOP_HOST_SECTIONS = `

## 用户发来的附件
用户消息末尾的「[附件]」列出本条消息随附的文件：它们已复制到一个只读的附件目录，清单给出了文件名与完整路径。文本类文件可用 read_file 读取；需要处理的二进制文件（图片、表格、PDF 等）用 execute 调用本机工具处理（产物写进工作区，不要写回附件目录）。只发附件没说要做什么时，先问用户想用它做什么。`;

/**
 * 登录 Web 账号后追加：生图 / 生视频 / 配音的段落与 Web 共用（agent-core MEDIA_GENERATION_PROMPT），
 * 再补一句桌面端附件的说法（Web 的附件全部是素材，桌面端只有带 versionId 的才是）。
 */
export const DESKTOP_MEDIA_SECTIONS =
  `\n\n${MEDIA_GENERATION_PROMPT}` +
  `\n\n## 附件作为生成素材\n「[附件]」里带 versionId 的图片 / 视频 / 音频已上传为本会话的生成素材，可经 referenceVersionIds 引用；需要用命令处理生成结果或附件时，用 sync_media_to_sandbox 把它们下载进工作区。`;

const PERMISSION_RULES: Record<WorkspacePermission, string> = {
  read_only:
    '- 本会话是**只读**权限：只能用 ls / read_file / glob / grep 查看文件，write_file、edit_file 与 execute 都会被拒绝。需要改动或执行时，告诉用户在会话顶栏把权限改为「询问」或「自动」。',
  ask: '- 本会话是**询问**权限：write_file、edit_file 与 execute 每次都要用户批准；用户拒绝某个操作后，不要换个写法重试同一操作，先问用户原因。',
  auto: '- 本会话是**自动**权限：工作区内的写文件与命令会直接执行，动手前想清楚影响范围，删除或覆盖已有文件前先确认。',
};

/**
 * 本机工作区区块（对应 backend 的沙箱区块；路径口径同为「文件工具与 execute 共用一条真实路径」）。
 * 工作区是用户为本会话自选的目录（可能是他自己的项目）；技能库在工作区外的只读运行目录。
 */
export function localWorkspaceBlock(opts: {
  skillsDir: string;
  permission: WorkspacePermission;
}): (w: string) => string {
  const { skillsDir, permission } = opts;
  return (w) => `

## 工作区与本机执行（execute）
- 你在用户自己的电脑上工作。本会话的工作区是 \`${w}\`（用户为这个会话选的目录，可能是他已有的项目，先 ls 了解结构再动手）。文件工具（ls / read_file / write_file / edit_file / glob / grep）与 execute 用**同一套路径**：\`${w}/my-app/index.html\` 在两边指同一个文件。
- 产物一律放在 \`${w}\` 下。execute 默认就在 \`${w}\` 里执行，也可以用相对路径。
- 文件工具只能访问 \`${w}\` 内的文件（技能库与附件目录除外，它们只读）。execute 虽然能访问整台电脑，也不要读写 \`${w}\` 以外的位置，除非用户明确要求。
${PERMISSION_RULES[permission]}
- 不要使用 sudo，不要修改系统设置，不要全局安装软件（brew install、npm -g、往系统 Python 里 pip install 等）；需要依赖时在项目目录里本地安装（npm install、python3 -m venv .venv 等）。
- \`${skillsDir}/\` 是只读技能库，禁止写入。技能 \`scripts/*\` 下的脚本用 execute 运行（如 \`python3 "${skillsDir}/<技能名>/scripts/xxx.py"\`，路径含空格时加引号）；运行前先读 SKILL.md 中对应脚本的运行说明。
- 单条命令最长 120 秒，超时会被终止；不要在前台启动 dev server 等长期运行的进程。
- 命令失败时把 stderr 关键行告诉用户，不要静默重试超过 2 次。`;
}

const todosSchema = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.string() })),
});

/** 当前任务计划文本（最近一条 plan_update）；没有计划返回空串 */
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

/**
 * 之前轮次已经用 /技能名 激活过某技能时，把它的 SKILL.md 全文注入系统提示，避免每轮重复 read_file。
 * 本轮才首次发起的 /command 不注入，交给通用段的「先 read_file SKILL.md」规则。
 */
export async function buildSkillPrompt(
  userTexts: string[],
  skillMd: (name: string) => Promise<string | null>,
  skillsDir: string,
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
  if (!active || active.index === currentIndex) return '';
  const content = absolutizeRefPaths(active.name, active.md, skillsDir);
  return (
    `\n\n## 已加载技能：${active.name}（SKILL.md 已提供，请勿重复读取）\n` +
    `本会话在之前的轮次已通过 \`/${active.name}\` 激活该技能，其 SKILL.md 全文见下。` +
    `请直接据此继续，**不要再 read_file 读取 \`${skillsDir}/${active.name}/SKILL.md\`**；` +
    `仅当需要其引用的 references/ 子技能等子文件时，才按需 read_file 那些子文件。\n\n` +
    `<skill name="${active.name}">\n${content}\n</skill>`
  );
}
