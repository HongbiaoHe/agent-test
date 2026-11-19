import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { countTokensApproximately } from 'langchain';
import type { ContextSummary, ReplayHistory } from './history';

/**
 * 跨轮历史压缩：按 **token 预算** 而不是条数控制重放的历史（原先是「最近 200 条」——一条工具结果
 * 可能几万 token，200 条也可能只有几百 token，条数与上下文占用不相关）。
 *
 * 照搬 deepagents summarization 中间件的做法（deepagents 1.10.2 dist createSummarizationMiddleware /
 * computeSummarizationDefaults）：
 *  - 用同一个计数器 countTokensApproximately 估算；
 *  - trigger：模型画像有 maxInputTokens 时按比例（框架 0.85），否则用固定 token 数（框架 170k）；
 *  - keep：从尾部按 token 保留最近一段，切点不拆开工具调用与其结果；
 *  - 被切掉的部分交给模型生成摘要，摘要以用户消息的形式放在保留段之前。
 *
 * 与框架中间件的分工：框架那份只在**一轮之内**压缩（它的摘要事件存在 checkpoint 里，每轮重置 thread
 * 后就没了）；这里在开跑前做、摘要由宿主落成 context_summary 行，后续轮次直接复用，不用每轮重新摘要。
 * 阈值刻意低于框架（0.5 vs 0.85）：给本轮的工具调用留出空间，开跑就触发框架的轮内压缩等于白压一次。
 */

/** 压缩阈值（token，countTokensApproximately 口径；不含系统提示与工具 schema） */
export interface HistoryBudget {
  /** 历史超过它就压缩 */
  triggerTokens: number;
  /** 压缩后从尾部保留的近期历史上限 */
  keepTokens: number;
}

/** 有画像时按上下文窗口的比例；都不超过固定上限（1M 窗口的模型按比例会到 50 万 token，成本不可接受） */
const TRIGGER_FRACTION = 0.5;
const KEEP_FRACTION = 0.1;
const TRIGGER_TOKENS = 150_000;
const KEEP_TOKENS = 30_000;
/** 交给摘要模型的原文上限（字符）：超出只留最近的部分，与框架 trimTokensToSummarize 同理 */
const MAX_SUMMARIZE_CHARS = 400_000;
/** 单条消息进摘要原文时的截断长度（大段工具结果只要开头） */
const MAX_MESSAGE_CHARS = 4_000;

const SUMMARY_PROMPT = `你是对话摘要器。下面是一段 agent 与用户的多轮对话（可能带一份更早的摘要和工具调用结果）。
写一份简洁的摘要，供 agent 在后续轮次里继续工作，必须覆盖：
1. 用户的目标与要求、明确表达过的偏好或约束；
2. 已经做出的决定、得出的结论、产出物（文件路径、生成的资源 id、链接等原样保留）；
3. 尚未完成的事项与当前进度；
4. 继续对话所需的其它关键上下文。
不要编造，不写无关细节。用对话使用的语言书写。

{conversation}

摘要：`;

/** 模型画像里的上下文窗口；拿不到返回 undefined（多数自定义型号没有画像） */
export function maxInputTokensOf(model: BaseChatModel): number | undefined {
  const profile: unknown = model.profile;
  if (
    profile &&
    typeof profile === 'object' &&
    'maxInputTokens' in profile &&
    typeof profile.maxInputTokens === 'number'
  ) {
    return profile.maxInputTokens;
  }
  return undefined;
}

export function historyBudgetFor(maxInputTokens?: number): HistoryBudget {
  if (!maxInputTokens) {
    return { triggerTokens: TRIGGER_TOKENS, keepTokens: KEEP_TOKENS };
  }
  return {
    triggerTokens: Math.min(
      TRIGGER_TOKENS,
      Math.floor(maxInputTokens * TRIGGER_FRACTION),
    ),
    keepTokens: Math.min(
      KEEP_TOKENS,
      Math.floor(maxInputTokens * KEEP_FRACTION),
    ),
  };
}

const SUMMARY_OPEN = '<context_summary>';
const SUMMARY_CLOSE = '</context_summary>';

/**
 * 摘要并进保留段的第一条用户消息（保留段总以用户消息开头）：不单独占一条，避免两条连续的
 * 用户消息（部分 provider 要求角色交替）。
 */
function withSummary(
  messages: readonly BaseMessage[],
  summary: string | null,
): BaseMessage[] {
  if (!summary || messages.length === 0) return [...messages];
  const [first, ...rest] = messages;
  const head =
    `${SUMMARY_OPEN}\n以下是本会话更早对话的摘要（原文已压缩，不再重放）：\n${summary}\n${SUMMARY_CLOSE}\n\n` +
    first.text;
  return [new HumanMessage(head), ...rest];
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS)}\n...(已截断)`;
}

/** 摘要原文：每条一段，工具调用写出名字与参数，单条过长截断 */
function transcript(messages: readonly BaseMessage[]): string {
  return messages
    .map((m) => {
      if (HumanMessage.isInstance(m)) return `用户：${clip(m.text)}`;
      if (ToolMessage.isInstance(m)) {
        return `工具结果（${m.name ?? 'tool'}）：${clip(m.text)}`;
      }
      if (AIMessage.isInstance(m)) {
        const calls = (m.tool_calls ?? [])
          .map((c) => `调用工具 ${c.name} ${clip(JSON.stringify(c.args))}`)
          .join('\n');
        return `助手：${clip(m.text)}${calls ? `\n${calls}` : ''}`;
      }
      return clip(m.text);
    })
    .join('\n\n');
}

/**
 * 保留段的起点：从尾部按 token 累计到 keepTokens 为止，再向后挪到最近的一条用户消息
 * （保留段以用户消息开头 = 不会拆开工具调用与结果）；至少保留最后一条用户消息（本轮）。
 */
function cutoffIndex(
  messages: readonly BaseMessage[],
  keepTokens: number,
): number {
  let kept = 0;
  let raw = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    kept += countTokensApproximately([messages[i]]);
    if (kept > keepTokens) {
      raw = i + 1;
      break;
    }
  }
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!HumanMessage.isInstance(messages[i])) continue;
    if (i >= raw) return i;
    lastUser = i;
  }
  return lastUser;
}

export interface CompactHistoryInput {
  history: ReplayHistory;
  /** 生成摘要用的模型（宿主传本轮装配的同一个模型） */
  model: BaseChatModel;
  /** 缺省按 model 的画像算（historyBudgetFor） */
  budget?: HistoryBudget;
  signal?: AbortSignal;
  /** 摘要失败时的日志：失败不阻断本轮，退化为直接丢掉切点之前的历史 */
  onError?: (e: unknown) => void;
}

export interface CompactedHistory {
  /** 喂给模型的消息 */
  messages: BaseMessage[];
  /** 本次新生成的摘要：宿主落成一条 context_summary 行（content 即它）；没压缩为 null */
  newSummary: ContextSummary | null;
}

export async function compactHistory(
  input: CompactHistoryInput,
): Promise<CompactedHistory> {
  const { history, model } = input;
  const budget = input.budget ?? historyBudgetFor(maxInputTokensOf(model));
  const prior = history.summary?.text ?? null;
  const messages = history.entries.map((e) => e.message);
  const assembled = withSummary(messages, prior);
  if (countTokensApproximately(assembled) <= budget.triggerTokens) {
    return { messages: assembled, newSummary: null };
  }

  const cut = cutoffIndex(messages, budget.keepTokens);
  if (cut <= 0) return { messages: assembled, newSummary: null };

  const older = transcript(messages.slice(0, cut));
  const source = prior
    ? `## 更早的摘要\n${prior}\n\n## 之后的对话\n${older}`
    : older;
  const conversation =
    source.length > MAX_SUMMARIZE_CHARS
      ? source.slice(source.length - MAX_SUMMARIZE_CHARS)
      : source;
  try {
    const res = await model.invoke(
      [
        new HumanMessage(
          SUMMARY_PROMPT.replace('{conversation}', conversation),
        ),
      ],
      { signal: input.signal },
    );
    const text = res.text.trim();
    if (!text) throw new Error('摘要模型返回空文本');
    return {
      messages: withSummary(messages.slice(cut), text),
      newSummary: { text, uptoSeq: history.entries[cut - 1].seq },
    };
  } catch (e) {
    if (input.signal?.aborted) throw e;
    input.onError?.(e);
    // 摘要失败：保留旧摘要 + 近期历史，切掉的部分本轮不重放（不落新摘要，下一轮再试）
    return {
      messages: withSummary(messages.slice(cut), prior),
      newSummary: null,
    };
  }
}
