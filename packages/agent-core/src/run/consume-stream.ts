import { z } from 'zod';
import {
  extractThinkingBlocks,
  normalize,
  type RawEvent,
} from '../agent/event-normalizer';
import {
  ReasoningCollector,
  type ReasoningPart,
} from '../agent/reasoning-parts';
import { type CallUsage, extractUsages } from '../agent/token-usage';

/**
 * 一轮 agent 流的消费：`agent.stream(input, { streamMode: ['updates', 'messages'], subgraphs: true })`
 * 产出的 `[namespace, mode, data]` → 推给前端的事件 + 落库的消息 + token 记账（backend 与 desktop 共用）。
 *
 * 宿主只实现 TurnSink（推流通道、message 表、token 明细表）；以下规则都在这里，改一处两端生效：
 *  1. 逐字 token 只推流不落库，按文本段累积；遇到工具调用 / 结果 / 计划 / 审批等非文本事件先把累积的
 *     文本收口成一条 message（推流 + 落库），保证落库顺序与用户看到的一致。
 *  2. updates 聚合出的 message 文本可能短于逐字流（思考 / 工具叙述被裁剪）：优先用累积的文本收口，
 *     没有逐字流（非流式模型）时才退回 updates 的文本。
 *  3. 思考按源消息归集（见 ReasoningCollector）：增量逐块推流，整段只落一行，且在其后第一个事件之前落库
 *     （seq 排在正文之前）。DeepSeek 走 messages 流增量，Gemini 只能从 updates 整块取。
 *  4. checkpoint 回放的旧消息：思考按 priorIds 整条丢弃，token 按 seenUsageIds 不重复记账——两个集合
 *     都由宿主在开跑前预热（前者读 checkpoint，后者读已落库的 messageId）。
 *  5. 被用户停止（signal 已 abort）时，已推给前端的残余文本收口落库后再把错误抛出，宿主只需补发
 *     result{stopped}；其它错误不收口（照旧由宿主报 error）。
 */

/** 宿主侧的落点。方法可同步可异步，这里一律 await，保证事件顺序。 */
export interface TurnSink {
  /** 推给前端（不落库） */
  emit(event: RawEvent): void | Promise<void>;
  /** 写 message 表（seq / role 由宿主定，role 可用 roleOf） */
  persist(event: RawEvent): void | Promise<void>;
  /**
   * 记一次模型调用的 token 明细，返回记账后的会话累计 token；已记过（唯一键冲突）或记账失败返回 null，
   * 此时不推 token_usage。
   */
  recordUsage(call: CallUsage): number | null | Promise<number | null>;
}

export interface ConsumeStreamOptions {
  /** run 开始前 checkpoint 里已有的消息 id（见 priorMessageIds） */
  priorIds: Set<string>;
  /** 已记过账的 AIMessage id（宿主从 token 明细表预热；本函数会往里加） */
  seenUsageIds: Set<string>;
  /** provider 没回模型名时（google-genai）记账用的模型名，取本次运行实际装配的模型 */
  fallbackModel: string;
  /** 停止信号：abort 后残余文本收口落库（见文件头第 5 条） */
  signal?: AbortSignal;
}

/** token_usage 事件载荷（前端只读 cumulativeTotal；其余给调试 / 报表对账） */
export interface TokenUsagePayload {
  model: string;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
  cumulativeTotal: number;
}

const streamChunk = z.tuple([z.array(z.string()), z.string(), z.unknown()]);
const textPayload = z.object({ text: z.string().optional() });
const reasoningPayload = z.object({ text: z.string(), sourceId: z.string() });

export async function consumeAgentStream(
  stream: AsyncIterable<unknown>,
  sink: TurnSink,
  opts: ConsumeStreamOptions,
): Promise<void> {
  const reasoning = new ReasoningCollector(opts.priorIds);
  let buf = '';

  const emitAndPersist = async (event: RawEvent) => {
    await sink.emit(event);
    await sink.persist(event);
  };
  /** 把累积的文本（或 override）收口成一条 message */
  const flushText = async (override?: string) => {
    const text = override ?? buf;
    buf = '';
    if (text) await emitAndPersist({ type: 'message', payload: { text } });
  };
  /** 本段新产生的思考按源消息各落一行 */
  const flushReasoning = async () => {
    for (const part of reasoning.drain()) {
      await sink.persist({ type: 'reasoning', payload: part });
    }
  };
  /** null = collector 判定该丢（历史重放 / 同轮回显 / 空文本） */
  const pushReasoning = async (part: ReasoningPart | null) => {
    if (part) await sink.emit({ type: 'reasoning', payload: part });
  };
  const recordUsage = async (call: CallUsage) => {
    const cumulativeTotal = await sink.recordUsage(call);
    if (cumulativeTotal === null) return;
    const payload: TokenUsagePayload = {
      model: call.model,
      input: call.input,
      output: call.output,
      total: call.total,
      cacheRead: call.cacheRead,
      cacheCreation: call.cacheCreation,
      cumulativeTotal,
    };
    await sink.emit({ type: 'token_usage', payload });
  };

  try {
    for await (const chunk of stream) {
      const [ns, mode, data] = streamChunk.parse(chunk);
      if (mode === 'updates') {
        // updates 给的是 state 里的完整 AIMessage：带 usage_metadata，Gemini 的思考块也只在这里
        for (const call of extractUsages(
          data,
          opts.seenUsageIds,
          opts.fallbackModel,
        )) {
          await recordUsage(call);
        }
        for (const part of extractThinkingBlocks(data)) {
          await pushReasoning(reasoning.takeBlock(part.id, part.text));
        }
      }
      const raw = normalize(ns, mode, data);
      if (!raw) continue;
      if (raw.type === 'reasoning') {
        const p = reasoningPayload.safeParse(raw.payload);
        if (p.success) {
          await pushReasoning(
            reasoning.appendDelta(p.data.sourceId, p.data.text),
          );
        }
        continue;
      }
      // 思考之后的第一个事件 = 这段思考结束 → 先落库，seq 排在前面
      await flushReasoning();
      if (raw.type === 'token') {
        buf += textPayload.safeParse(raw.payload).data?.text ?? '';
        await sink.emit(raw);
        continue;
      }
      if (raw.type === 'message') {
        await flushText(buf || textPayload.safeParse(raw.payload).data?.text);
        continue;
      }
      // 其余事件（tool_start / tool_end / plan_update / control_request）是文本段边界
      await flushText();
      await emitAndPersist(raw);
    }
    await flushReasoning();
    await flushText(); // 末段文本没有后继事件触发收口
  } catch (e) {
    if (opts.signal?.aborted) await flushText();
    throw e;
  }
}
