import type { AskAction } from "./chat";

/**
 * langchain HITL（1.4.2）的人工决策。resume 时 decisions 必须与本次中断挂起的
 * 工具调用**一一对应、数量相等**，否则 hitl 中间件抛
 * 「Number of human decisions (n) does not match number of hanging tool calls (m)」。
 */
export type HitlDecision =
  | { type: "approve" }
  | { type: "reject"; message: string }
  | {
      type: "edit";
      editedAction: { name: string; args: Record<string, unknown> };
    };

/** 用户在确认面板上的意图；面板整批表态，逐项决策由工具名派生。 */
export type AskIntent =
  | { kind: "answer"; text: string }
  | { kind: "approve" }
  | { kind: "reject" };

const REJECT_GENERATE =
  "用户拒绝了本次生成，即放弃了该节点这次的生成意图。禁止重试同一节点或改用其他方式触发生成；" +
  "不要声称已生成任何内容。节点保持未生成状态；继续其他任务，或仅在需要时就下一步方向征询用户。";
const REJECT_DEFAULT =
  "用户拒绝了此操作，即取消了该操作意图（例如：拒绝清空画布 = 不要删除节点）。" +
  "禁止改用其他工具去达成同一目的（不要再逐个 delete_node，也不要再次 clear_canvas）。" +
  "画布保持现状不变，不要声称已完成或已删除任何内容；停止该动作，转而询问用户或继续其他任务。";
const SKIP_ASK = "用户未回答这个问题，请按你的最佳判断继续，不要重复追问同一件事。";

/** reject 必须带明确 message 回灌模型：默认拒绝语义模糊，模型会误以为操作已完成。 */
function rejectMessage(tool: string): string {
  return tool === "generate_media_node" ? REJECT_GENERATE : REJECT_DEFAULT;
}

/**
 * 把「整批一次表态」展开成与挂起调用一一对应的决策序列。
 *
 * 同一批里可能混着不同工具（ask_user 只允许 edit/reject，确认型只允许 approve/reject，
 * 见 canvas.agent.factory 的 interruptOn），所以每项按自己的工具名取决策：
 * - answer：首个 ask_user 用 edit 写入答案；同批其余提问按「未回答」跳过；
 *   非提问类**不**顺带批准（回答问题不等于批准破坏性/消耗性操作）。
 * - approve：确认型逐个 approve；ask_user 不支持 approve，按「未回答」跳过。
 * - reject：全部 reject，文案按工具定制。
 */
export function buildDecisions(
  actions: AskAction[],
  intent: AskIntent,
): HitlDecision[] {
  let answered = false;
  return actions.map((a) => {
    if (a.tool === "ask_user") {
      if (intent.kind === "answer" && !answered) {
        answered = true;
        return {
          type: "edit",
          editedAction: { name: "ask_user", args: { question: intent.text } },
        };
      }
      return { type: "reject", message: SKIP_ASK };
    }
    if (intent.kind === "approve") return { type: "approve" };
    return { type: "reject", message: rejectMessage(a.tool) };
  });
}
