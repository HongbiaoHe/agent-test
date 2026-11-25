import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

/**
 * 运行中插入用户消息（steering）：agent 还在跑的时候用户又发来的消息，在主 agent **下一次模型调用前**
 * 作为用户消息写进对话——不打断正在执行的工具，也不等这一轮结束。
 *
 * 为什么是 beforeModel 写 state，而不是 dynamic-context 那种每次调用临时挂在消息尾：
 * 写进 state 只发生一次、位置固定（上一步的工具结果之后、这次模型调用之前），之后这一轮里每次模型调用
 * 的前缀都不变，prompt cache 不受影响；临时挂尾的话它每次都「挪到最后」，前缀每次都变。
 *
 * 只挂在主 agent 上（宿主经 buildAgent 的 middleware 传入；deepagents 不把宿主中间件给子 agent）：
 * 子 agent 在跑的时候不受影响，等它返回、主 agent 再次调用模型时才插入。
 *
 * 落库与推流不在这里做：这条 HumanMessage 会出现在 updates 流里（normalize → user_message），
 * consumeAgentStream 按流的顺序交给宿主（TurnSink.steered），保证它在 message 表里排在上一步工具结果之后。
 * 直接在钩子里落库会抢在还没消费完的工具结果事件前面，重放历史时顺序就错了。
 */

/** 给模型看的固定说明：让它把这条消息当成对当前任务的补充，而不是丢下手头的事另起一轮 */
export const STEERING_NOTE =
  '[用户在你执行任务的过程中发来了下面这条消息。继续当前任务时一并考虑；如果它改变了要求，以它为准。]';

/** 插入消息给模型的正文：固定说明 + 原文。实时注入与历史重放必须用同一个函数，前缀才一致 */
export function steeringText(text: string): string {
  return `${STEERING_NOTE}\n\n${text}`;
}

/** 一条待插入的消息：id 用于去重与宿主对账；text 是给模型的完整正文（宿主已经套好 steeringText） */
export interface SteeringMessage {
  id: string;
  text: string;
}

/** 插入消息在 HumanMessage.additional_kwargs 里的标记（normalize 据此认出它） */
export const STEERING_KWARG = 'steering';

export function isSteeringMessage(msg: BaseMessage): boolean {
  return (
    HumanMessage.isInstance(msg) &&
    msg.additional_kwargs[STEERING_KWARG] === true
  );
}

/**
 * take：取走当前所有待插入的消息（宿主保证同一条不会给两次）。没有就返回空数组，这次模型调用照常进行。
 * 多条一起写入，只触发这一次模型调用。
 */
export function createSteeringMiddleware(
  take: () => Promise<SteeringMessage[]> | SteeringMessage[],
) {
  return createMiddleware({
    name: 'steeringMiddleware',
    beforeModel: async () => {
      const items = await take();
      if (items.length === 0) return;
      return {
        messages: items.map(
          (item) =>
            new HumanMessage({
              id: item.id,
              content: item.text,
              additional_kwargs: { [STEERING_KWARG]: true },
            }),
        ),
      };
    },
  });
}
