import type { ThinkingAnimation } from "../_components/thinking-indicator";
import { PHASE_UI, type AgentPhase } from "../_lib/thinking-phase";

/**
 * 介绍页要讲的「一种动画 = 一种状态」清单。
 *
 * animation 与 sample 都从 PHASE_UI 取，不在这里重写一遍：
 * 哪档配哪种波、那档会说什么话，权威在 thinking-phase.ts。这一页只补面向用户的说法
 * （PHASE_UI.hint 是给开发看的判定条件，不适合直接摆在产品介绍里）。
 *
 * standby 不属于 AgentPhase——它是 agentUi 为空时的兜底（canvas-shell.tsx:160），
 * 所以只有它的两个字段是本文件写死的。
 */
export interface AgentFace {
  key: AgentPhase | "standby";
  animation: ThinkingAnimation;
  /** 状态名（一个词） */
  name: string;
  /** 人话：它此刻在干什么 */
  meaning: string;
  /** 九格具体怎么动——这一档的辨识点 */
  rhythm: string;
  /** 画布上这一档真的会显示的一句话 */
  sample: string;
}

export const AGENT_FACES: AgentFace[] = [
  {
    key: "thinking",
    animation: PHASE_UI.thinking.animation,
    name: "Thinking",
    meaning:
      "It is working the problem out and has not touched your board yet. Nothing has moved, nothing has been spent.",
    rhythm: "Nine cells breathing out of step, each on its own period.",
    sample: PHASE_UI.thinking.phrases[0],
  },
  {
    key: "working",
    animation: PHASE_UI.working.animation,
    name: "Working",
    meaning:
      "The run is moving: placing nodes, connecting edges, firing a generation, writing back to you.",
    rhythm: "A diagonal wave rolling across the grid, corner to corner.",
    sample: PHASE_UI.working.phrases[0],
  },
  {
    key: "loading",
    animation: PHASE_UI.loading.animation,
    name: "Looking around",
    meaning:
      "A step just closed and the next one is not decided yet. It is orienting, not stuck.",
    rhythm: "The outer eight light up clockwise around a fixed centre.",
    sample: PHASE_UI.loading.phrases[0],
  },
  {
    key: "standby",
    animation: "standby",
    name: "Standing by",
    meaning:
      "Idle, and awake. It sits in the rail of your board waiting for the next sentence from you.",
    rhythm:
      "One slow breath every 4.5s, spreading from the centre outwards. Stops entirely if you ask for reduced motion.",
    // canvas-shell.tsx:172 —— 空闲时触发按钮上真正的 tooltip 文案
    sample: "Agent standing by",
  },
];
