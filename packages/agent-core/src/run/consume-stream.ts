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
 * 一轮 agent 流的消费：`agent.stream(input, { streamMode: AGENT_STREAM_MODES })` 产出的
 * `[namespace, mode, data]`（subgraphs: true）或 `[mode, data]`（不开 subgraphs，如设计 agent）
 * → 推给前端的事件 + 落库的消息 + token 记账（Spark backend / desktop 与设计 agent 共用）。
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
 *  6. 同一条 AIMessage 会在 updates 里跨节点回显多次：正文按消息 id、工具调用按 tool_call id 只认第一次
 *     （没有 id 的不去重——宁可重复也不误吞）；工具结果按 toolCallId 只认第一次（普通工具在 messages 与
 *     updates 里各出现一次）。
 *  7. 子 agent（deepagents 的 task 工具）：其内部事件的 namespace 以 `tools:<任务 id>` 开头。这些事件
 *     带上 `subagent: { callId, name }` 推流落库，前端嵌在对应 task 卡片下，历史重放跳过它们（主对话只认
 *     task 的最终结果）；文本段按 agent 分别累积，并行的子 agent 互不串段。任务 id → task 调用的对应
 *     来自 `tasks` 流模式（ns 为空、name=tools 的任务输入里带 lg_tool_call）。子 agent 的 todo 计划不推不落：
 *     它会顶掉主计划卡片，且 buildActivePlan 读「最近一次计划」会读到它。
 *  8. 运行中插入的用户消息（run/steering.ts）：updates 里的 user_message{ids} 是文本段边界，逐个 id 交给
 *     TurnSink.steered——由宿主落库（role=user）并推给前端。按 id 只认第一次（审批续跑会回放 updates）。
 */

/** 本轮 agent.stream 要开的流模式（tasks 用于把子 agent 的 namespace 对应到 task 调用） */
export const AGENT_STREAM_MODES = ['updates', 'messages', 'tasks'] as const;

/** 子 agent 归属：发起它的 task 调用 id 与子 agent 类型（映射不到时 callId 是 namespace 段、name 为空） */
export interface SubagentRef {
  callId: string;
  name: string;
}

/** 宿主侧的落点。方法可同步可异步，这里一律 await，保证事件顺序。 */
export interface TurnSink {
  /** 推给前端（不落库） */
  emit(event: RawEvent): void | Promise<void>;
  /** 写 message 表（seq / role 由宿主定，role 可用 roleOf） */
  persist(event: RawEvent): void | Promise<void>;
  /**
   * 记一次模型调用的 token 明细，返回记账后的会话累计 token；已记过（唯一键冲突）或记账失败返回 null，
   * 此时不推 token_usage。不记 token 的宿主（设计 agent）不实现，这里就不抽取用量。
   */
  recordUsage?(call: CallUsage): number | null | Promise<number | null>;
  /**
   * 运行中插入的一条用户消息已经写进对话（见 run/steering.ts）：宿主按 id 把它落库（role=user）并推给前端。
   * 调用时机就是它在流里的位置——上一步的工具结果已经落库，下一次模型输出还没开始。不支持插入的宿主不实现。
   */
  steered?(id: string): void | Promise<void>;
}

export interface ConsumeStreamOptions {
  /** run 开始前 checkpoint 里已有的消息 id（见 priorMessageIds）；没有 checkpointer 的宿主不传 */
  priorIds?: Set<string>;
  /**
   * 与 createThinkingTap 共用的思考归集器（给了就忽略 priorIds，由宿主构造时自己带上）。
   * 不挂实时回调的宿主不传，这里按 priorIds 新建。
   */
  reasoning?: ReasoningCollector;
  /**
   * 非文本事件（tool_start / tool_end / plan_update / control_request）推流落库前的宿主改写：
   * 返回 null = 整条丢弃（也不触发文本段收口）。如设计 agent 把 tool_end 里的图换成占位。
   */
  mapEvent?: (event: RawEvent) => RawEvent | null;
  /** 已记过账的 AIMessage id（宿主从 token 明细表预热；本函数会往里加）；不记 token 的宿主不传 */
  seenUsageIds?: Set<string>;
  /** provider 没回模型名时（google-genai）记账用的模型名，取本次运行实际装配的模型 */
  fallbackModel?: string;
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

const streamChunk = z.union([
  z.tuple([z.array(z.string()), z.string(), z.unknown()]),
  // 不开 subgraphs 时没有 namespace
  z
    .tuple([z.string(), z.unknown()])
    .transform(([mode, data]): [string[], string, unknown] => [[], mode, data]),
]);
const textPayload = z.object({
  text: z.string().optional(),
  sourceId: z.string().optional(),
});
const reasoningPayload = z.object({ text: z.string(), sourceId: z.string() });
const toolStartPayload = z.object({
  tool_calls: z.array(z.object({ id: z.string().optional() }).loose()),
});
const toolEndPayload = z.object({ toolCallId: z.string().optional() });
const steeredPayload = z.object({ ids: z.array(z.string()) });
/** tasks 流里 tools 节点的任务：每个工具调用一个任务（Send），输入里带本次调用 */
const toolsTask = z.object({
  id: z.string(),
  name: z.literal('tools'),
  input: z.object({
    lg_tool_call: z.object({
      id: z.string(),
      name: z.string(),
      args: z.object({ subagent_type: z.string().optional() }).loose(),
    }),
  }),
});

const TOOLS_NS = 'tools:';

export async function consumeAgentStream(
  stream: AsyncIterable<unknown>,
  sink: TurnSink,
  opts: ConsumeStreamOptions,
): Promise<void> {
  const reasoning = opts.reasoning ?? new ReasoningCollector(opts.priorIds);
  const seenUsageIds = opts.seenUsageIds ?? new Set<string>();
  /** 按 agent 分开累积的逐字文本：'' = 主 agent，其余 = 子 agent 的 callId */
  const buffers = new Map<
    string,
    { text: string; agent: SubagentRef | null }
  >();
  /** 已收口的正文源消息 id、已推出的 tool_call id 与工具结果 id（见文件头第 6 条） */
  const seenMessageIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  const seenToolEndIds = new Set<string>();
  const seenSteeredIds = new Set<string>();
  /** tools 任务 id → 发起它的 task 调用（见文件头第 7 条） */
  const taskCalls = new Map<string, SubagentRef>();
  /** 思考源消息 id → 所属子 agent（落库时带上） */
  const reasoningAgents = new Map<string, SubagentRef>();

  /**
   * 子 agent 判定：namespace 首段是 tools 任务，且确实是子图里的事件——updates 在 tools 任务下出现就只能是子图；
   * messages 里普通工具的结果本身就带 `tools:<id>` 一段，要再往下一层才是子 agent。
   */
  const subagentOf = (ns: string[], mode: string): SubagentRef | null => {
    const head = ns[0];
    if (!head?.startsWith(TOOLS_NS)) return null;
    if (mode === 'messages' && ns.length < 2) return null;
    return (
      taskCalls.get(head.slice(TOOLS_NS.length)) ?? { callId: head, name: '' }
    );
  };
  const tag = (event: RawEvent, agent: SubagentRef | null): RawEvent =>
    agent && event.payload && typeof event.payload === 'object'
      ? { ...event, payload: { ...event.payload, subagent: agent } }
      : event;

  const emitAndPersist = async (event: RawEvent) => {
    await sink.emit(event);
    await sink.persist(event);
  };
  /** 把某个 agent 累积的文本（或 override）收口成一条 message */
  const flushText = async (agent: SubagentRef | null, override?: string) => {
    const key = agent?.callId ?? '';
    const text = override ?? buffers.get(key)?.text ?? '';
    buffers.delete(key);
    if (text) {
      await emitAndPersist(tag({ type: 'message', payload: { text } }, agent));
    }
  };
  const flushAllText = async () => {
    for (const { agent } of [...buffers.values()]) await flushText(agent);
  };
  /** tool_start 去掉已推出过的调用（有 id 的才认）；全是回显返回 null */
  const dedupeToolStart = (event: RawEvent): RawEvent | null => {
    const parsed = toolStartPayload.safeParse(event.payload);
    if (!parsed.success) return event;
    const calls = parsed.data.tool_calls.filter(
      (c) => !c.id || !seenToolCallIds.has(c.id),
    );
    if (calls.length === 0) return null;
    for (const c of calls) if (c.id) seenToolCallIds.add(c.id);
    return calls.length === parsed.data.tool_calls.length
      ? event
      : { type: 'tool_start', payload: { tool_calls: calls } };
  };
  /** tool_end 按 toolCallId 只认第一次（没有 id 的不去重） */
  const dedupeToolEnd = (event: RawEvent): RawEvent | null => {
    const id = toolEndPayload.safeParse(event.payload).data?.toolCallId;
    if (!id) return event;
    if (seenToolEndIds.has(id)) return null;
    seenToolEndIds.add(id);
    return event;
  };
  /** 本段新产生的思考按源消息各落一行 */
  const flushReasoning = async () => {
    for (const part of reasoning.drain()) {
      const agent = reasoningAgents.get(part.sourceId) ?? null;
      await sink.persist(tag({ type: 'reasoning', payload: part }, agent));
    }
  };
  /** null = collector 判定该丢（历史重放 / 同轮回显 / 空文本） */
  const pushReasoning = async (
    part: ReasoningPart | null,
    agent: SubagentRef | null,
  ) => {
    if (!part) return;
    if (agent && part.sourceId) reasoningAgents.set(part.sourceId, agent);
    await sink.emit(tag({ type: 'reasoning', payload: part }, agent));
  };
  const recordUsage = async (call: CallUsage) => {
    const cumulativeTotal = await sink.recordUsage?.(call);
    if (cumulativeTotal == null) return;
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
      if (mode === 'tasks') {
        const task = ns.length === 0 ? toolsTask.safeParse(data) : null;
        const call = task?.success ? task.data.input.lg_tool_call : null;
        if (task?.success && call?.name === 'task') {
          taskCalls.set(task.data.id, {
            callId: call.id,
            name: call.args.subagent_type ?? '',
          });
        }
        continue;
      }
      const agent = subagentOf(ns, mode);
      if (mode === 'updates') {
        // updates 给的是 state 里的完整 AIMessage：带 usage_metadata，Gemini 的思考块也只在这里。
        // 子 agent 的模型调用同样计费，一并记账
        if (sink.recordUsage) {
          for (const call of extractUsages(
            data,
            seenUsageIds,
            opts.fallbackModel ?? '',
          )) {
            await recordUsage(call);
          }
        }
        for (const part of extractThinkingBlocks(data)) {
          await pushReasoning(reasoning.takeBlock(part.id, part.text), agent);
        }
      }
      const raw = normalize(ns, mode, data);
      if (!raw) continue;
      if (raw.type === 'reasoning') {
        const p = reasoningPayload.safeParse(raw.payload);
        if (p.success) {
          await pushReasoning(
            reasoning.appendDelta(p.data.sourceId, p.data.text),
            agent,
          );
        }
        continue;
      }
      // 子 agent 的 todo 计划不推不落（见文件头第 7 条）
      if (agent && raw.type === 'plan_update') continue;
      // 思考之后的第一个事件 = 这段思考结束 → 先落库，seq 排在前面
      await flushReasoning();
      const key = agent?.callId ?? '';
      if (raw.type === 'token') {
        const text = textPayload.safeParse(raw.payload).data?.text ?? '';
        buffers.set(key, {
          text: (buffers.get(key)?.text ?? '') + text,
          agent,
        });
        await sink.emit(tag(raw, agent));
        continue;
      }
      if (raw.type === 'message') {
        const p = textPayload.safeParse(raw.payload).data;
        if (p?.sourceId) {
          if (seenMessageIds.has(p.sourceId)) continue; // 跨节点回显
          seenMessageIds.add(p.sourceId);
        }
        await flushText(agent, buffers.get(key)?.text || p?.text);
        continue;
      }
      if (raw.type === 'user_message') {
        // 只认主 agent 的（子 agent 不挂 steering 中间件，这里再兜一层）
        const ids = agent
          ? []
          : (steeredPayload.safeParse(raw.payload).data?.ids ?? []);
        const fresh = ids.filter((id) => !seenSteeredIds.has(id));
        if (fresh.length === 0) continue;
        await flushText(agent);
        for (const id of fresh) {
          seenSteeredIds.add(id);
          await sink.steered?.(id);
        }
        continue;
      }
      // 其余事件（tool_start / tool_end / plan_update / control_request）是文本段边界
      const deduped =
        raw.type === 'tool_start'
          ? dedupeToolStart(raw)
          : raw.type === 'tool_end'
            ? dedupeToolEnd(raw)
            : raw;
      const event = deduped && opts.mapEvent ? opts.mapEvent(deduped) : deduped;
      if (!event) continue;
      await flushText(agent);
      await emitAndPersist(tag(event, agent));
    }
    await flushReasoning();
    await flushAllText(); // 末段文本没有后继事件触发收口
  } catch (e) {
    if (opts.signal?.aborted) await flushAllText();
    throw e;
  }
}
