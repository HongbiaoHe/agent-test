import { isBaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { BuiltAgent } from '../agent/agent.factory';

/**
 * 从 agent.getState(config)（LangGraph 的 checkpoint 快照）里读宿主关心的两件事。
 * 快照是外部运行时的数据，用 zod 收窄，不做断言。
 */

const stateMessages = z.object({
  values: z.object({ messages: z.array(z.unknown()).optional() }).optional(),
});

/**
 * run 开始前 checkpoint 里已有的消息 id。审批续跑时 updates 流会把它们整批回放，
 * 其思考已在上一段落过库，ReasoningCollector 据此整条丢掉。
 * 读不到就返回空集（功能降级为不排除），绝不因此让整轮跑挂。
 */
export async function priorMessageIds(
  agent: Pick<BuiltAgent, 'getState'>,
  config: unknown,
  onError?: (e: unknown) => void,
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const parsed = stateMessages.safeParse(await agent.getState(config));
    for (const m of parsed.data?.values?.messages ?? []) {
      if (isBaseMessage(m) && m.id) ids.add(m.id);
    }
  } catch (e) {
    onError?.(e);
  }
  return ids;
}

const interruptState = z.object({
  tasks: z
    .array(
      z.object({
        interrupts: z.array(z.object({ value: z.unknown() })).optional(),
      }),
    )
    .optional(),
});

const interruptValue = z.object({
  actionRequests: z.array(z.object({ name: z.string().optional() })).optional(),
});

/** 流结束后挂起的 HITL 中断（state.tasks 是 LangGraph 的概念，不是业务表） */
export interface PendingInterrupt {
  /** 中断载荷，原样作为 control_request 事件的 payload 交给前端 */
  value: unknown;
  /** 被拦下的工具名（ask_user / send_email / MCP 工具……）；宿主据此决定超时行为 */
  toolName?: string;
}

/**
 * 取第一个挂起的中断；没有中断（本轮正常结束）返回 null。
 * 快照形状认不出就抛错：当成「没有中断」会把停在审批上的会话静默标成 done，用户再也续不了跑。
 */
export function readInterrupt(state: unknown): PendingInterrupt | null {
  const parsed = interruptState.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `无法从 checkpoint 快照读取审批中断（LangGraph 快照形状变了？）：${parsed.error.message}`,
    );
  }
  const first = (parsed.data.tasks ?? []).flatMap((t) => t.interrupts ?? [])[0];
  if (!first) return null;
  return {
    value: first.value,
    toolName: interruptValue.safeParse(first.value).data?.actionRequests?.[0]
      ?.name,
  };
}
