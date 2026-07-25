import { initChatModel } from 'langchain/chat_models/universal';
import { createDeepAgent, StateBackend } from 'deepagents';
import {
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from 'langchain';
import { z } from 'zod';
import { injectActivePlan } from '../agent/plan-injection';

/**
 * 画布 harness agent 装配。与 src/agent 完全独立（独立系统提示 / 工具 / interruptOn），
 * 只借用同样的装配套路。可长跑（>1h）：write_todos 规划 + guardrails 防失控 + checkpointer 续跑。
 */

const CANVAS_SYSTEM_PROMPT = `你是"画布工作流编排 Agent"：在一块可视化画布上，通过增删节点与连线，自动搭建一条工作流，并按需触发生成，最终交付用户想要的图像/视频产出。你的动作（建节点、连线、触发生成）会实时反映到用户的画布上。

## 画布模型
画布由**节点**和**有向连线**组成。节点有 4 种：
- \`text\`：文本/说明/提示词草稿节点（写 text）。
- \`image_upload\`：用户上传的图片（MVP 为模拟占位，可作为下游生成的参考图来源）。
- \`image_gen\`：生图节点（写 prompt；可由入边的上游图片作参考图）。
- \`video_gen\`：生视频节点（写 prompt；可由入边的上游图片作首帧）。
连线表示数据流向 A→B（A 是 B 的上游输入）。典型工作流：text(创意) → image_gen(出图) → video_gen(成片)，或 image_upload → image_gen(图生图)。

## 工作方式（持续执行 + 规划）
1. 先用 \`write_todos\` 把目标拆成有序步骤（如：设计分镜 → 建文本节点 → 建生图节点并连线 → 触发生图 → 建生视频节点并连线 → 触发生视频）。逐步推进，完成一步标记一步。
2. **画布当前状态（全部节点/连线/节点 id + 放置安全区）每一轮都会自动注入在系统提示末尾的「当前画布实时状态」区块里——直接读它，无需调用任何工具查询画布。**
3. 用 \`add_node\` / \`connect_nodes\` / \`update_node\` 搭建结构。**新节点的位置(x,y)必须放进「放置安全区」给出的坐标范围**（现有节点的右侧或下方），否则会与已有节点重叠。需要**重排/挪动已有节点**时，用 \`update_node\` 带上新的 x/y（同样放进安全区，避免重叠）。
4. 生成节点搭好、提示词就绪后，用 \`generate_media_node\` 触发实际生成——它会自动沿该节点的入边收集上游已完成的图片版本作为参考图/首帧。生成是异步的：触发后立即返回，卡片状态会自动更新，**不要轮询或重复触发同一节点**。
5. 需要用户澄清（风格、数量、方向等）时，用 \`ask_user\` 提问并等待回答后再继续。

## 语言
以用户消息的语言回复（默认简体中文）。工具调用过程用户可见，无需复述每一步。

## 执行到底（重要）
把计划里的每一步在**同一次运行内依次做完**：开始一步标 in_progress、做完标 completed，然后立刻继续下一步，直到**所有 todo 都为 completed**。只有全部完成后才给最终总结结束；计划还有 pending/in_progress 时**绝不提前收尾或停下**（除非确需 ask_user 澄清，得到回答后继续做完）。

## 尊重用户的拒绝（重要）
当某个需确认的操作被用户**拒绝（reject）**时，表示用户**放弃了该操作意图**——**绝不能改用其他工具去达成同一目的**（例如 \`clear_canvas\` 被拒后，禁止再逐个 \`delete_node\` 删除，也禁止再次 \`clear_canvas\`）。停止该动作、保持现状。**拒绝本身就是答案，不要再用 \`ask_user\` 就同一操作复述一遍是/否确认**（如"那要清空吗？""确认取消清空？"）；转而继续其他任务，或仅在需要时就**下一步方向**征询用户。

## 纪律（避免冗余调用，控制成本）
- **严禁"建一批再全删重做"**：不要删除自己刚建的节点去重来。\`delete_node\` 用于删除个别节点。搭错了优先用 \`update_node\` 改，而不是删了重加。
- **删除所有节点 / 推倒重来**：用 \`clear_canvas\` 一次清空（会请用户确认后执行），**不要逐个 \`delete_node\` 去删全部**（那样慢且易只删一部分）。\`clear_canvas\` **自身已内建"请用户确认"环节**——需要清空时**直接调用它**即可，**绝不要先用 \`ask_user\` 问"要不要清空 / 确认清空吗"再调用**（那是重复确认，且会让确认变成一个要用户手打的开放式提问，而不是「确认/取消」按钮）。
- 只搭建与用户目标相关的节点，不堆砌无关节点；不要反复重排。
- 画布状态已随每轮实时注入（见「当前画布实时状态」），**不要调用工具查询画布**；\`add_node\`/\`connect_nodes\` 的返回值也已含 nodeId/edgeId，直接用。
- \`write_todos\` 用来维护同一份计划的状态推进（pending→in_progress→completed），**不要反复整表重写计划**。
- 触发生成前确保该 image_gen/video_gen 节点已写好 prompt。\`generate_media_node\` **自身已内建"请用户确认"环节**（同 clear_canvas）——需要生成时**直接调用它**即可，**绝不要先用 \`ask_user\` 问"要不要生成 / 确认生成吗"**；被拒绝即用户放弃该次生成，不要重试或绕道。
- 不确定的关键选择（而非细枝末节）才用 ask_user，避免频繁打断。`;

/** 运行时 context：activePlan（跨轮计划回注）+ userId + sessionId。 */
const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string(),
  sessionId: z.string(),
});

/** 计划延续中间件：把既有任务计划注入系统提示末尾（复用 agent 模块纯逻辑）。 */
const planContinuationMiddleware = createMiddleware({
  name: 'canvasPlanContinuationMiddleware',
  wrapModelCall: injectActivePlan as never,
});

/**
 * 模型标识解析（与 agent.factory 同策略）。画布用**独立**的 CANVAS_MODEL env，
 * 不复用现有 agent 的 GOOGLE_GENAI_MODEL —— 换画布模型不波及主 agent。
 * 默认 gemini-3.1-pro-preview（3.1 里能做对话的强模型；3.1-flash 不存在=404、3.1-flash-lite 执行力弱）。
 */
function resolveChatModel(model?: string) {
  const name = model ?? process.env.CANVAS_MODEL ?? 'gemini-3.1-pro-preview';
  if (name.includes(':')) return initChatModel(name);
  return initChatModel(name, { modelProvider: 'google-genai' });
}

export interface BuildCanvasAgentOptions {
  checkpointer?: unknown;
  systemPromptExtra?: string;
  model?: string;
  /** 画布操作工具（worker 闭包注入 sessionId/userId）。 */
  tools: unknown[];
  /**
   * 实时画布上下文提供器：每次模型调用前按 sessionId 取「当前节点/连线 + 放置安全区」文本，
   * 注入系统提示末尾。让 agent 每轮都拿到最新画布，无需调用 get_canvas。
   */
  liveCanvasContext?: (sessionId: string) => Promise<string>;
}

/** 对外最小 agent 接口（避免泄漏 deepagents 类型）。 */
export interface BuiltCanvasAgent {
  stream(
    input: unknown,
    config?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
  getState(config: unknown): Promise<unknown>;
}

export async function buildCanvasAgent(
  opts: BuildCanvasAgentOptions,
): Promise<BuiltCanvasAgent> {
  const model = await resolveChatModel(opts.model);

  // 实时画布状态中间件：每次模型调用前按 sessionId 取最新「节点/连线 + 安全区」注入系统提示末尾。
  // 闭包 opts.liveCanvasContext（worker 用 CanvasService 提供）。放在中间件链最后 = 离模型最近，
  // 保证模型读到的画布状态最新鲜。
  const canvasStateMiddleware = createMiddleware({
    name: 'canvasLiveStateMiddleware',
    wrapModelCall: (async (
      request: {
        systemMessage: { concat: (s: string) => unknown };
        runtime?: { context?: { sessionId?: string } };
      },
      handler: (req: unknown) => unknown,
    ) => {
      const sid = request.runtime?.context?.sessionId;
      if (!sid || !opts.liveCanvasContext) return handler(request);
      const text = await opts.liveCanvasContext(sid);
      if (!text) return handler(request);
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(`\n\n${text}`),
      });
    }) as never,
  });

  // guardrails：长跑需较高上限，触顶优雅结束（end）而非抛错。中间件顺序即 recency，
  // planContinuation / canvasState 靠后离模型最近；实时画布状态排最后，模型读到的最新鲜。
  // 注：不再对 delete_node 设每轮上限——那会把合法的"删除多个/全部节点"也卡死（只删了一部分）。
  // "删除所有"改用 clear_canvas 一次清空（需用户确认）；防"建了又全删"thrashing 交给系统提示。
  const middleware = [
    modelCallLimitMiddleware({ threadLimit: 500, exitBehavior: 'end' }),
    toolCallLimitMiddleware({ threadLimit: 2000, exitBehavior: 'continue' }),
    planContinuationMiddleware,
    canvasStateMiddleware,
  ];

  return createDeepAgent({
    model,
    systemPrompt: CANVAS_SYSTEM_PROMPT + (opts.systemPromptExtra ?? ''),
    tools: opts.tools as never[],
    backend: new StateBackend(),
    contextSchema,
    middleware,
    // ask_user：暂停等用户输入。langchain 1.4.2 的 HITL 决策仅 approve/edit/reject（无 respond）——
    // 用 edit 把用户答案写进 ask_user 的 args，工具随即以"答案"为返回值执行，模型据此续跑；
    // reject 作"跳过/按最佳判断继续"兜底（其 message 会回传给模型）。
    interruptOn: {
      ask_user: { allowedDecisions: ['edit', 'reject'] },
      // 清空画布有破坏性 → 暂停等用户 approve/reject（approve 才执行清空）
      clear_canvas: { allowedDecisions: ['approve', 'reject'] },
      // 生成消耗配额/时间 → 不自动执行，弹确认（approve 才真正触发生成）
      generate_media_node: { allowedDecisions: ['approve', 'reject'] },
    },
    checkpointer: opts.checkpointer as never,
  });
}
