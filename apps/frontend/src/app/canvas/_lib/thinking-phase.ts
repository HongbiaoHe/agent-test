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
 *
 * 写文案的三条约束：
 * 1. 每条都必须对当前阶段成立。等待文案是在替 agent 报告状态，读起来像在撒谎就砸信任。
 * 2. 幽默要干、要克制。2.6s 换一条、一次执行能刷十几条，用力讲的笑话第三遍就开始烦人；
 *    平静的荒谬（「跟自己吵架」「删掉一个副词」）比抖机灵耐看。
 * 3. 第 0 条留给最朴素的那句：它固定是首帧（SSR 与水合都用它），
 *    冷启动第一眼不该是个还没进入语境的玩笑。
 *
 * 长度上限：换词窗口是单行 overflow:hidden，超宽直接被裁。聊天面板最窄 320px 时
 * 窗口约剩 263px（面板宽 − 状态条 pl-2/pr-4 − 指示器自带的 7.6+18+7.6），
 * 10.44px 字号下最长的一条实测 135px，还有一倍余量——但别把这份余量花掉：
 * 一句话长到要扫视才读完，就不再是「瞥一眼知道它还活着」了。
 */
export const PHASE_UI: Record<
  AgentPhase,
  { animation: ThinkingAnimation; phrases: readonly string[]; hint: string }
> = {
  thinking: {
    animation: "pulse",
    hint: "推理文本正在流式产出",
    // 在想，还没动手。所以全是「脑内活动」，没有一条提到画布被改动
    phrases: [
      "Thinking",
      "Doing the clever bit",
      "Arguing with myself",
      "Talking myself out of it",
      "Considering a worse idea",
      "Sleeping on it, briefly",
      "Measuring twice",
      "Turning it over",
    ],
  },
  working: {
    animation: "wave",
    hint: "工具调用还没回",
    // 正在改画布，措辞就得是动手的：节点、连线、对齐。域内的具体动作比泛泛的「处理中」好笑
    phrases: [
      "Wiring up the nodes",
      "Herding the boxes",
      "Untangling the edges",
      "Nudging things half a pixel",
      "Teaching two nodes to talk",
      "Bribing an arrow to bend",
      "Dragging boxes into place",
      "Making the arrows agree",
    ],
  },
  responding: {
    // 与 working 同样是「在推进」，用同一种波；靠文案区分是在写字还是在动手
    animation: "wave",
    hint: "正文正在逐字流式输出",
    // 在写字。用编辑室的动作（删副词、砍废话）把「写」和「动手改画布」分开
    phrases: [
      "Writing it up",
      "Putting it in words",
      "Deleting an adverb",
      "Cutting the boring part",
      "Saying it shorter",
      "Wrapping up the thought",
      "Almost there",
    ],
  },
  loading: {
    animation: "orbit",
    hint: "刚发出请求 / 上一步已收口，下一步未明",
    // 下一步未明，所以只能承认状态本身：在找、在翻、在决定，不许假装已经在干某件具体事
    phrases: [
      "Getting started",
      "Warming up",
      "Consulting the canvas",
      "Rummaging through tools",
      "Finding where I left off",
      "Deciding what happens next",
      "Checking my own notes",
      "Reading the room",
    ],
  },
};
