import { z } from 'zod';

/**
 * 历史重放：deepagents 跑完一轮不在持久化 state 里保留对话消息（同 thread_id 续跑拿不到上文），
 * 所以每轮开跑前由宿主从自己的 message 表取行，经这里转成喂给模型的消息（backend 与 desktop 共用）。
 *
 * 只重放 user / assistant 文本消息与 tool_end 工具结果；tool_call_id 是合成值（库里不存原始 id），
 * 只为满足 ToolMessage 结构。
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
};

/** 落库事件的 role；表里没登记的类型按 assistant */
export function roleOf(type: string): string {
  return ROLE_BY_TYPE[type] ?? 'assistant';
}

/** 重放窗口：最近 200 条 */
export const MAX_HISTORY_MESSAGES = 200;

/** message 表里的一行（宿主按 seq 升序给） */
export interface HistoryRow {
  role: string;
  type: string;
  seq: number;
  content: unknown;
}

/** 喂给模型的一条历史消息 */
export interface HistoryMessage {
  role: string;
  content: string;
  tool_call_id?: string;
}

const textPayload = z.object({ text: z.string().optional() });
const toolEndPayload = z.object({
  name: z.string().optional(),
  content: z.unknown(),
});

/** 工具结果正文：字符串原样，其它序列化（没有内容给空串） */
function toolResultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : (JSON.stringify(content) ?? '');
}

/**
 * 行 → 历史消息：取最近 MAX_HISTORY_MESSAGES 条，再从头部去掉非 user 行（对话起点必须是用户）。
 * userText：用户消息正文怎么给模型由宿主决定（附件清单的写法两端不同）。
 */
export async function historyFromRows(
  rows: readonly HistoryRow[],
  userText: (content: unknown) => string | Promise<string>,
): Promise<HistoryMessage[]> {
  const replayable = rows.filter(
    (m) =>
      (m.type === 'message' || m.type === 'tool_end') &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'),
  );
  let slice =
    replayable.length > MAX_HISTORY_MESSAGES
      ? replayable.slice(-MAX_HISTORY_MESSAGES)
      : replayable;
  while (slice.length > 0 && slice[0].role !== 'user') slice = slice.slice(1);

  const out: HistoryMessage[] = [];
  for (const m of slice) {
    if (m.type === 'tool_end') {
      const p = toolEndPayload.safeParse(m.content);
      out.push({
        role: 'tool',
        content: p.success ? toolResultText(p.data.content) : '',
        tool_call_id: `synth_${(p.success && p.data.name) || 'tool'}_${m.seq}`,
      });
      continue;
    }
    out.push({
      role: m.role,
      content:
        m.role === 'user'
          ? await userText(m.content)
          : (textPayload.safeParse(m.content).data?.text ?? ''),
    });
  }
  return out;
}
