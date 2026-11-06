import { HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

/**
 * 动态上下文：每次模型调用前由 provider 现算，只改发给模型的那一份（不写回 state、不落库）。
 * 两种落点：
 *   - system_tail：按顺序接到系统提示末尾（recency 最强，盖过 deepagents 内置中间件的提示）；
 *   - message：作为一条 HumanMessage 追加到本次消息尾（画布状态这类随对话变化、体积大的内容：
 *     放 messages 尾比改 system prompt 对 prompt cache 更友好，见 canvas-state-injection）。
 * 替代了原先各自为政的 systemPromptExtra / context.activePlan / 画布状态注入三条路。
 * provider 每次模型调用都会跑，查库的 provider 要自己缓存（这是宿主的责任，不是 core 的）。
 */

export type DynamicPlacement = 'system_tail' | 'message';

export interface DynamicPart {
  placement: DynamicPlacement;
  text: string;
}

export interface DynamicRuntime {
  context?: Record<string, unknown>;
}

export type DynamicContextProvider = (
  runtime: DynamicRuntime,
) => Promise<DynamicPart[] | null> | DynamicPart[] | null;

/** 纯逻辑，便于单测：不依赖 langchain 的中间件类型。 */
export function applyDynamicParts<
  R extends {
    systemMessage: { concat(s: string): unknown };
    messages: readonly unknown[];
  },
>(request: R, parts: readonly DynamicPart[]): R {
  if (parts.length === 0) return request;
  const tails = parts
    .filter((p) => p.placement === 'system_tail' && p.text)
    .map((p) => `\n\n${p.text}`);
  const extra = parts
    .filter((p) => p.placement === 'message' && p.text)
    .map((p) => new HumanMessage(p.text));
  return {
    ...request,
    systemMessage: tails.length
      ? request.systemMessage.concat(tails.join(''))
      : request.systemMessage,
    messages: extra.length ? [...request.messages, ...extra] : request.messages,
  };
}

/**
 * 内置 provider：worker 经 `context.activePlan` 传入的「当前任务计划」接到系统提示末尾。
 * 为什么是末尾：deepagents 的 todoListMiddleware 会往系统提示追加「随时重订计划」，多轮里
 * 诱导模型整表重写 todos；计划放最后（离模型最近）才能盖过它。
 */
export const activePlanProvider: DynamicContextProvider = (runtime) => {
  const plan = runtime.context?.activePlan;
  return typeof plan === 'string' && plan
    ? [{ placement: 'system_tail', text: plan }]
    : null;
};

/** 依次跑 provider；某个 provider 抛错只记日志并跳过，不让整轮模型调用失败。 */
export async function collectDynamicParts(
  providers: readonly DynamicContextProvider[],
  runtime: DynamicRuntime,
  log?: (message: string) => void,
): Promise<DynamicPart[]> {
  const parts: DynamicPart[] = [];
  for (const provider of providers) {
    try {
      const out = await provider(runtime);
      if (out) parts.push(...out);
    } catch (e) {
      log?.(`dynamic context provider failed: ${String(e)}`);
    }
  }
  return parts;
}

export function createDynamicContextMiddleware(
  providers: readonly DynamicContextProvider[],
  log?: (message: string) => void,
) {
  return createMiddleware({
    name: 'dynamicContextMiddleware',
    wrapModelCall: async (request, handler) => {
      const parts = await collectDynamicParts(
        providers,
        {
          context: request.runtime.context as
            | Record<string, unknown>
            | undefined,
        },
        log,
      );
      return handler(applyDynamicParts(request, parts));
    },
  });
}
