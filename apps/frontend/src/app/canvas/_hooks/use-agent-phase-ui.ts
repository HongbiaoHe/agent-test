"use client";

import { useRotatingPhrase, type ThinkingAnimation } from "../_components/thinking-indicator";
import type { ChatItem } from "../_lib/chat";
import { PHASE_UI, agentPhase, type AgentPhase } from "../_lib/thinking-phase";

/** phrases 为空时也要调 useRotatingPhrase（hook 不能条件调用），给个稳定的空数组 */
const NO_PHRASES: readonly string[] = [];

export interface AgentPhaseUi {
  phase: AgentPhase;
  animation: ThinkingAnimation;
  /** 当前轮换到的文案，与对话流里指示器用的是同一组措辞 */
  phrase: string;
}

/**
 * agent 执行状态的「一句话 + 一种方阵动画」。对话面板收起（桌面）或抽屉关着（手机）时，
 * 入口按钮拿它把静态图标换成对应阶段的脉动方阵、把提示换成该阶段的文案——
 * 面板看不见时，执行状态就只能从这个入口透出来。
 *
 * agent 不忙时返回 null（入口按钮回到静态图标）。
 */
export function useAgentPhaseUi(
  items: ChatItem[],
  busy: boolean,
): AgentPhaseUi | null {
  const phase = agentPhase(items, busy);
  const phrases = phase ? PHASE_UI[phase].phrases : NO_PHRASES;
  const { current } = useRotatingPhrase(phrases.length);
  if (!phase) return null;
  return {
    phase,
    animation: PHASE_UI[phase].animation,
    phrase: phrases[current] ?? phrases[0] ?? "",
  };
}
