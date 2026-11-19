import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';

/**
 * 历史重放：宿主的 message 表是对话记忆的**唯一事实源**。每轮（kind=run）开跑前宿主清掉该会话的
 * checkpoint thread，再经这里把行转成喂给模型的消息（backend 与 desktop 共用）。
 *
 * 为什么不靠 checkpointer 记多轮：backend 的 RedisSaver 跑完一轮读不回 messages（只存本步变化的
 * channel），desktop 的 SqliteSaver 却完整保留——两端同一套编排，一边丢上文、一边把重放的历史再叠
 * 一份（实测模型收到 U1,A1,U1,A1,U2）。checkpoint 只用于同一轮内的审批中断 → 续跑。
 *
 * 重放内容：
 *  - user / assistant 正文；
 *  - 工具调用与结果**成对**重建：tool_start 的 tool_calls（带原始 id）+ 同 id 的 tool_end →
 *    AIMessage(tool_calls) 紧跟对应 ToolMessage。只重放拿到了结果的调用（被停止 / 拒绝 / 中断的丢掉），
 *    孤立的工具结果（旧数据没有 toolCallId）不重放——没有配对的 ToolMessage 到不了模型，只会占预算；
 *  - 子 agent 的内部事件（content.subagent）不重放：它们只给前端展示，主对话只认 task 工具的最终结果；
 *  - 最近一条 context_summary（见 compaction.ts）之前的行由摘要代替。
 */

/** 事件落库时的 role（宿主按 type 写 message 表；历史重放据此筛行） */
export const ROLE_BY_TYPE: Readonly<Record<string, string>> = {
  message: 'assistant',
  result: 'assistant',
  plan_update: 'assistant',
  tool_start: 'assistant',
  tool_end: 'tool',
  control_request: 'assistant',
  reasoning: 'assistant',
  error: 'assistant',
  context_summary: 'system',
};

/** 落库事件的 role；表里没登记的类型按 assistant */
export function roleOf(type: string): string {
  return ROLE_BY_TYPE[type] ?? 'assistant';
}

/** 重放会读到的行类型（宿主查表时据此过滤，少读无关行） */
export const REPLAY_ROW_TYPES: readonly string[] = [
  'message',
  'tool_start',
  'tool_end',
  'context_summary',
];

/** message 表里的一行（宿主按 seq 升序给） */
export interface HistoryRow {
  role: string;
  type: string;
  seq: number;
  content: unknown;
}

/** 已持久化的上下文摘要（context_summary 行的 content）：seq ≤ uptoSeq 的行都由 text 代替 */
export interface ContextSummary {
  text: string;
  uptoSeq: number;
}

/** 一条重放消息及其来源行的 seq（压缩时据此记 uptoSeq） */
export interface HistoryEntry {
  seq: number;
  message: BaseMessage;
}

export interface ReplayHistory {
  /** 摘要之后的消息，首条必为用户消息 */
  entries: HistoryEntry[];
  /** 最近一条摘要；没压缩过为 null */
  summary: ContextSummary | null;
  /** 全部用户轮次的正文（含已被摘要的）：/command 技能激活与 runName 用 */
  userTexts: string[];
}

export const contextSummarySchema = z.object({
  text: z.string().min(1),
  uptoSeq: z.number().int(),
});
const textPayload = z.object({ text: z.string().optional() });
const toolStartPayload = z.object({
  tool_calls: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
const toolEndPayload = z.object({
  name: z.string().optional(),
  content: z.unknown(),
  status: z.enum(['success', 'error']).optional(),
  toolCallId: z.string().optional(),
});

/** 子 agent 内部事件（见 consume-stream）：只展示，不进主对话 */
export function isSubagentRow(content: unknown): boolean {
  return (
    typeof content === 'object' &&
    content !== null &&
    'subagent' in content &&
    content.subagent != null
  );
}

/**
 * 工具结果正文：字符串原样；内容块数组只留文字，其它块（图片等 base64）换成一句说明——
 * 序列化进去会把整张图的 base64 当文本重放，白白吃掉上下文预算。
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks: unknown[] = content;
    return blocks
      .map((b) =>
        typeof b === 'object' &&
        b !== null &&
        'type' in b &&
        b.type === 'text' &&
        'text' in b &&
        typeof b.text === 'string'
          ? b.text
          : '[非文本内容已省略]',
      )
      .join('\n');
  }
  return content == null ? '' : (JSON.stringify(content) ?? '');
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 一次工具调用分组：可选的前导正文 + 调用 + 已拿到的结果 */
interface ToolGroup {
  seq: number;
  text: string;
  calls: ToolCall[];
  results: Map<string, ToolMessage>;
}

/** 最近一条有效摘要；没有返回 null */
export function latestSummary(
  rows: readonly HistoryRow[],
): ContextSummary | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type !== 'context_summary') continue;
    const parsed = contextSummarySchema.safeParse(rows[i].content);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * 行 → 重放历史。userText：用户消息正文怎么给模型由宿主决定（附件清单的写法两端不同）。
 */
export async function historyFromRows(
  rows: readonly HistoryRow[],
  userText: (content: unknown) => string | Promise<string>,
): Promise<ReplayHistory> {
  const summary = latestSummary(rows);
  const userTexts: string[] = [];
  const entries: HistoryEntry[] = [];
  let group: ToolGroup | null = null;
  /** 刚落下、还没被工具调用接上的助手正文（同一条 AIMessage 的正文与 tool_calls 是分两行落库的） */
  let pendingText: HistoryEntry | null = null;

  const flushText = () => {
    if (pendingText) entries.push(pendingText);
    pendingText = null;
  };
  /** 分组收口：只留拿到结果的调用，AIMessage 后紧跟它的 ToolMessage（OpenAI 兼容端要求相邻） */
  const flushGroup = () => {
    if (!group) return;
    const g = group;
    group = null;
    const answered = g.calls.filter((c) => g.results.has(c.id));
    if (answered.length === 0) {
      if (g.text) {
        entries.push({ seq: g.seq, message: new AIMessage(g.text) });
      }
      return;
    }
    entries.push({
      seq: g.seq,
      message: new AIMessage({
        content: g.text,
        tool_calls: answered.map((c) => ({
          id: c.id,
          name: c.name,
          args: c.args,
          type: 'tool_call' as const,
        })),
      }),
    });
    for (const c of answered) {
      const result = g.results.get(c.id);
      if (result) entries.push({ seq: g.seq, message: result });
    }
  };

  for (const row of rows) {
    const isUser = row.role === 'user' && row.type === 'message';
    if (isUser) userTexts.push(await userText(row.content));
    if (summary && row.seq <= summary.uptoSeq) continue;
    if (isSubagentRow(row.content)) continue;

    if (isUser) {
      flushGroup();
      flushText();
      entries.push({
        seq: row.seq,
        message: new HumanMessage(userTexts[userTexts.length - 1]),
      });
      continue;
    }
    if (row.type === 'message' && row.role === 'assistant') {
      flushGroup();
      flushText();
      const text = textPayload.safeParse(row.content).data?.text ?? '';
      if (text) {
        pendingText = { seq: row.seq, message: new AIMessage(text) };
      }
      continue;
    }
    if (row.type === 'tool_start') {
      const parsed = toolStartPayload.safeParse(row.content);
      if (!parsed.success) continue;
      const calls = parsed.data.tool_calls.flatMap((c): ToolCall[] =>
        c.id ? [{ id: c.id, name: c.name, args: c.args ?? {} }] : [],
      );
      if (calls.length === 0) continue;
      // 审批续跑会把同一个调用改写参数后再发一次 tool_start（id 不变）：并进当前分组、换成最终参数
      if (
        group &&
        calls.every((c) => group?.calls.some((x) => x.id === c.id))
      ) {
        for (const c of calls) {
          const prev = group.calls.find((x) => x.id === c.id);
          if (prev) prev.args = c.args;
        }
        continue;
      }
      flushGroup();
      const lead: HistoryEntry | null = pendingText;
      pendingText = null;
      group = {
        seq: lead?.seq ?? row.seq,
        text: lead ? lead.message.text : '',
        calls,
        results: new Map(),
      };
      continue;
    }
    if (row.type === 'tool_end') {
      const parsed = toolEndPayload.safeParse(row.content);
      const id = parsed.data?.toolCallId;
      const call = id ? group?.calls.find((c) => c.id === id) : undefined;
      if (!parsed.success || !group || !call || !id) continue;
      group.results.set(
        id,
        new ToolMessage({
          content: toolResultText(parsed.data.content),
          tool_call_id: id,
          // Gemini 要求工具结果带函数名
          name: parsed.data.name ?? call.name,
          status: parsed.data.status ?? 'success',
        }),
      );
    }
  }
  flushGroup();
  flushText();

  // 对话起点必须是用户
  const firstUser = entries.findIndex((e) =>
    HumanMessage.isInstance(e.message),
  );
  return {
    entries:
      firstUser > 0 ? entries.slice(firstUser) : firstUser < 0 ? [] : entries,
    summary,
    userTexts,
  };
}
