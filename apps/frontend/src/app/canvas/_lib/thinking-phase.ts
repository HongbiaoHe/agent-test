import type { ThinkingAnimation } from "../_components/thinking-indicator";

import type { ChatItem } from "./chat";

/** agent 当前所处阶段，决定流末尾指示器的形态。 */
export type AgentPhase = "thinking" | "working" | "responding" | "loading";

/**
 * 从消息流末尾推断 agent 在干什么；null = 不显示指示器（只在 agent 不忙时）。
 *
 * 只要 busy 就一定给出一个阶段：执行流是「正文 → 工具 → 正文 → 工具」交替的，
 * 中间任何一段返回 null 都会让指示器一段段地消失又出现，读起来像卡顿而不是留白。
 */
export function agentPhase(
  items: ChatItem[],
  busy: boolean,
): AgentPhase | null {
  if (!busy) return null;
  const last = items[items.length - 1];
  // 请求刚发出，一个回执都还没有
  if (!last) return "loading";
  switch (last.kind) {
    case "reasoning":
      // 推理文本正在流式产出 = 真的在「想」
      return last.streaming ? "thinking" : "loading";
    case "tool":
      // 工具还没回 = 正在动手干活
      return last.done ? "loading" : "working";
    case "assistant":
      // 正文正在逐字吐出来 = 在写结论
      return last.streaming ? "responding" : "loading";
    // user / plan / error 之后的等待都归为「还不知道下一步是什么」
    default:
      return "loading";
  }
}

/**
 * 各阶段的呈现：动画方式对应「在想 / 在动手 / 情况未明」三种体感，
 * 文案也跟着换——正在执行工具时还显示「Doing the clever bit」会前后矛盾。
 */
export const PHASE_UI: Record<
  AgentPhase,
  { animation: ThinkingAnimation; phrases: readonly string[]; hint: string }
> = {
  thinking: {
    animation: "pulse",
    hint: "推理文本正在流式产出",
    phrases: [
      "Thinking",
      "Doing the clever bit",
      "Weighing the options",
      "Chasing a better idea",
      "Measuring twice",
      "Plotting a route",
    ],
  },
  working: {
    animation: "wave",
    hint: "工具调用还没回",
    phrases: [
      "Wiring up the nodes",
      "Untangling the edges",
      "Herding the boxes",
      "Sketching it out",
      "Moving things around",
      "Connecting the dots",
    ],
  },
  responding: {
    // 与 working 同样是「在推进」，用同一种波；靠文案区分是在写字还是在动手
    animation: "wave",
    hint: "正文正在逐字流式输出",
    phrases: [
      "Writing it up",
      "Putting it in words",
      "Wrapping up the thought",
      "Almost there",
    ],
  },
  loading: {
    animation: "orbit",
    hint: "刚发出请求 / 上一步已收口，下一步未明",
    phrases: [
      "Getting started",
      "Warming up",
      "Consulting the canvas",
      "Rummaging through tools",
      "Lining things up",
    ],
  },
};
