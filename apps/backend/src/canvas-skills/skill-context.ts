import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { absolutizeRefPaths } from '../skills/skill-files';

/**
 * 画布技能的上下文文本（纯逻辑，无 IO，便于单测；同 canvas/canvas-state-injection.ts）。
 *
 * ## 为什么不用 deepagents 自带的 `skills` 参数
 *
 * deepagents 的 SkillsMiddleware 在 wrapModelCall 里把技能清单 `systemMessage.concat(...)` 拼到
 * **系统提示末尾**（dist/index.js createSkillsMiddleware）。系统提示排在全部消息之前：用户在会话中途
 * 新建/停用一个技能，清单一变，整段对话历史的 prompt cache 从第一个 token 起全部作废。
 *
 * 这里照 Claude 的做法改走消息通道：
 *  - 系统提示只放一段**固定不变**的技能使用说明（CANVAS_SKILLS_PROMPT），不含清单；
 *  - 清单（名称 + 说明，progressive disclosure 的第一层）作为一条「## 可用技能」消息追加进对话，
 *    只有清单变了才追加新的一份——之前的消息一个字都不动，前缀 append-only；
 *  - 用户 `/技能名` 显式调用时，把该技能的 SKILL.md 全文作为一条「## 已调用技能」消息追加；
 *  - 模型自己判断要用某技能时，照 deepagents 规范 `read_file /skills/<名>/SKILL.md`（第二层），
 *    引用的子文件再按需读（第三层）。
 *
 * 两类消息都由 worker 落库、随历史重放，跨轮位置固定，不会每轮漂到末尾重付。
 */

/**
 * 系统提示里的技能使用说明。**固定文本、不含清单**：任何用户、任何时刻都是同一段，
 * 系统提示因此不随技能增删而变，前缀缓存不受影响。清单走消息（见文件头注释）。
 */
export const CANVAS_SKILLS_PROMPT = `

## 技能（Skills）
技能是可复用的工作流说明书，存放在只读目录 \`/skills/<技能名>/\`，入口是其中的 \`SKILL.md\`。
- 对话里的「${'## 可用技能'}」消息列出当前可用技能的名称与说明（可能有多份，以最后一份为准）。任务与某个技能相符时，先用 \`read_file\` 读 \`/skills/<技能名>/SKILL.md\`（limit=1000）再照做；SKILL.md 提到的其他文件，用到时再读。
- 用户消息以 \`/<技能名>\` 开头 = 显式指定该技能：其全文会以「${'## 已调用技能：<技能名>'}」消息给出，直接遵循，不必再读；命令后的文字是这次的输入。
- \`/skills/\` 只读。创建或修改技能只能用 \`save_skill\`，动手前先遵循 \`skills-creator\` 技能。`;

/** 注入消息的识别标记：作为正文首行，回读时据此找出上一份同类注入。 */
export const SKILLS_LISTING_MARKER = '## 可用技能';
export const SKILL_INVOCATION_MARKER = '## 已调用技能：';

/** 进清单所需的最小形状 */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * 技能清单文本。顺序必须确定（调用方已排好：内置在前、各自按名称），
 * 同一组技能每次产出逐字相同的文本——比对「清单变没变」靠的就是全文相等。
 */
export function buildSkillsListing(skills: readonly SkillSummary[]): string {
  const lines = skills.map(
    (s) => `- ${s.name}：${oneLine(s.description) || '（无说明）'}`,
  );
  return [
    SKILLS_LISTING_MARKER,
    '下面是当前可用的技能（名称：说明）。任务与某个技能相符时，先 read_file /skills/<名称>/SKILL.md（limit=1000）再照做；用户用 /<名称> 调用时会直接给出全文。清单有变化会再次出现，以最后一份为准。',
    '',
    ...(lines.length > 0 ? lines : ['（暂无可用技能）']),
  ].join('\n');
}

/** 显式调用：把 SKILL.md 全文连同用户输入一起交给模型 */
export function buildSkillInvocation(
  name: string,
  skillMd: string,
  args: string,
): string {
  return [
    `${SKILL_INVOCATION_MARKER}${name}`,
    `用户用 /${name} 调用了这个技能，按下面的说明（/skills/${name}/SKILL.md 全文）执行，不必再 read_file 读它；说明里提到的其他文件在 /skills/${name}/ 下，需要时再读。`,
    `本次输入：${args.trim() || '（无，按技能说明执行）'}`,
    '',
    skillMd.trim(),
  ].join('\n');
}

/** 消息开头的 `/技能名`：名称按 Agent Skills 规范（小写字母/数字/连字符，≤64） */
const SLASH = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s+([\s\S]*))?$/;

/** 解析显式调用；不是 `/名称` 开头返回 null */
export function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  const m = SLASH.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}

/** 由三段式参数拼出规范的 SKILL.md（frontmatter 交给这里，模型只写正文） */
export function buildSkillMd(
  name: string,
  description: string,
  instructions: string,
): string {
  // description 用 JSON 字符串形式写进 YAML：冒号、引号、# 都不会破坏 frontmatter
  return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine(description))}\n---\n\n${stripFrontmatter(instructions).trim()}\n`;
}

/**
 * 运行中清单有变（save_skill 存了新技能）→ 本次模型调用前追加一份新清单。
 * 走 beforeModel 写进 state，理由同 canvas-state-injection.buildCanvasStateUpdate。
 */
export async function buildSkillsListingUpdate(
  state: { messages: BaseMessage[] },
  getListing?: () => Promise<string>,
): Promise<{ messages: BaseMessage[] } | undefined> {
  if (!getListing) return undefined;
  const text = await getListing();
  if (!text || lastMarked(state.messages, SKILLS_LISTING_MARKER) === text) {
    return undefined;
  }
  return { messages: [new HumanMessage(text)] };
}

/** 倒序找最后一条以 marker 开头的消息正文；没有则 null */
export function lastMarked(
  messages: readonly { text: string }[],
  marker: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].text.startsWith(marker)) return messages[i].text;
  }
  return null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 模型可能自带了 frontmatter：去掉，统一由 buildSkillMd 生成 */
function stripFrontmatter(s: string): string {
  return s.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

/** 两类注入在 CanvasMessage 里的 type（role 都是 user：对模型而言它们是对话里的一条用户侧消息） */
export const SKILLS_LISTING_TYPE = 'skills_listing';
export const SKILL_INVOCATION_TYPE = 'skill_invocation';

export interface SkillContextRow {
  type: typeof SKILLS_LISTING_TYPE | typeof SKILL_INVOCATION_TYPE;
  text: string;
  /** 调用的技能名（仅 invocation） */
  name?: string;
}

/**
 * run 开头要落库的技能上下文（纯函数：worker 查好现状传进来，按返回值写库）。
 *
 * - 清单：重放窗口里最后一份与当前不同（或没有）才写一份新的。没变就什么都不写——
 *   历史逐字不变，前缀整段命中。
 * - 调用：最近一条用户消息是 `/技能名 …`、该技能可用、且还没为这条消息写过调用 → 写一份
 *   SKILL.md 全文。「已写过」用于 job 重试 / 续跑时不重复注入。
 *
 * 顺序：清单在前、调用在后（都排在用户消息之后）。
 */
export function planSkillContext(input: {
  listing: string;
  lastListing: string | null;
  userText: string | null;
  alreadyInvoked: boolean;
  skills: readonly { name: string; files: Record<string, string> }[];
}): SkillContextRow[] {
  const rows: SkillContextRow[] = [];
  if (input.listing !== input.lastListing) {
    rows.push({ type: SKILLS_LISTING_TYPE, text: input.listing });
  }
  const cmd = input.userText ? parseSlashCommand(input.userText) : null;
  const skill = cmd && input.skills.find((s) => s.name === cmd.name);
  const skillMd = skill?.files['SKILL.md'];
  if (cmd && skillMd && !input.alreadyInvoked) {
    rows.push({
      type: SKILL_INVOCATION_TYPE,
      name: cmd.name,
      text: buildSkillInvocation(
        cmd.name,
        absolutizeRefPaths(cmd.name, skillMd),
        cmd.args,
      ),
    });
  }
  return rows;
}
