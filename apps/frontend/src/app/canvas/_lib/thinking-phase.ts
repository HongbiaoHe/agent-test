import type { ThinkingAnimation } from "../_components/thinking-indicator";

import type { ChatItem } from "./chat";

/**
 * agent 当前所处阶段，决定流末尾指示器的形态。三档对应三种体感：
 * 在想 / 在推进 / 情况未明。
 */
export type AgentPhase = "thinking" | "working" | "loading";

/**
 * 从消息流末尾推断 agent 在干什么；null = 不显示指示器（只在 agent 不忙时）。
 *
 * 只要 busy 就一定给出一个阶段：执行流是「正文 → 工具 → 正文 → 工具」交替的，
 * 中间任何一段返回 null 都会让指示器一段段地消失又出现，读起来像卡顿而不是留白。
 *
 * 为什么正文流式产出也算 working 而不单开一个「在写结论」档：
 * 流里分不出这段正文是最终答案还是两次工具调用之间的过场旁白——没有任何信号标明
 * 「这是最后一段」。既然分不出，就不该拿形态去承诺它。对用户来说这两种都是同一件事：
 * 活儿还在往前走。plan 同理，待办一冒出来就说明已经在执行了。
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
      // 正文在吐或刚收口，都是这一轮执行的一部分，活儿没停
      return "working";
    case "plan":
      // 待办已经列出来 = 计划在执行中
      return "working";
    // user / error 之后的等待才是真的「还不知道下一步是什么」
    default:
      return "loading";
  }
}

/**
 * 各阶段的呈现。三档 × 三种动画，一一对应，不再有两档共用一种波：
 * 在想（pulse 错峰脉动）/ 在推进（wave 斜向推进）/ 情况未明（orbit 绕圈找方向）。
 * 文案也跟着换——正在执行工具时还显示「Doing the clever bit」会前后矛盾。
 *
 * 写文案的三条约束：
 * 1. 每条都必须对当前阶段成立。等待文案是在替 agent 报告状态，读起来像在撒谎就砸信任。
 * 2. 幽默要干、要克制。2.6s 换一条、一次执行能刷十几条，用力讲的笑话第三遍就开始烦人；
 *    平静的荒谬（「跟自己吵架」「贿赂一根连线让它拐弯」）比抖机灵耐看。
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
    hint: "工具还没回 / 正文在产出 / 计划在执行——这一轮活儿正在往前走",
    /* 这一档现在覆盖整段执行（工具、正文、计划），是停留最久的状态，所以给足 11 条。
       措辞只说「在推进画布这件事」，不说此刻具体在敲哪个字：
       原 responding 那批编辑室笑话（删副词、砍废话）没并进来——工具卡片明晃晃写着
       Add node 时，旁边配一句「Deleting an adverb」是在报告另一件没发生的事。
       节点/连线这类说法反过来成立：它讲的是这趟活儿本身，正文旁白时也不算撒谎。 */
    phrases: [
      "Wiring up the nodes",
      "Herding the boxes",
      "Untangling the edges",
      "Nudging things half a pixel",
      "Teaching two nodes to talk",
      "Bribing an arrow to bend",
      "Dragging boxes into place",
      "Making the arrows agree",
      "Doing the actual work",
      "Getting on with it",
      "Still at it",
    ],
  },
  loading: {
    animation: "orbit",
    hint: "刚发出请求 / 推理或工具刚收口，下一步未明",
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
