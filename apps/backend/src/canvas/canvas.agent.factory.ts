import { Logger } from '@nestjs/common';
import { initChatModel } from 'langchain/chat_models/universal';
import { createDeepAgent, StateBackend } from 'deepagents';
import { SystemMessage } from '@langchain/core/messages';
import {
  buildCanvasStateUpdate,
  buildPlanUpdate,
} from './canvas-state-injection';
import {
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from 'langchain';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { keepsNativeBlocks, stripNonPortableBlocks } from './portable-content';
import type { CanvasApprovalMode } from './canvas.types';
import {
  type CanvasThinkingLevel,
  thinkingModelParams,
} from './thinking-level';
import {
  ExplicitCacheRegistry,
  cacheKey,
  explicitCacheTtlSeconds,
  isCacheInvalidError,
  isExplicitCacheEnabled,
  planFollowingCache,
  rebuildThresholdChars,
  toFunctionDeclarations,
} from './explicit-cache';

/**
 * 画布 harness agent 装配。与 src/agent 完全独立（独立系统提示 / 工具 / interruptOn），
 * 只借用同样的装配套路。可长跑（>1h）：write_todos 规划 + guardrails 防失控 + checkpointer 续跑。
 */

const CANVAS_SYSTEM_PROMPT = `你是"画布工作流编排 Agent"：在一块可视化画布上，通过增删节点与连线，自动搭建一条工作流，并按需触发生成，最终交付用户想要的图像/视频产出。你的动作（建节点、连线、触发生成）会实时反映到用户的画布上。

## 画布模型
画布由**节点**和**有向连线**组成。节点有 4 种：
- \`image_upload\`：用户上传的图片（MVP 为模拟占位，可作为下游生成的参考图来源）。
- \`image_gen\`：生图节点（提示词写在它**自己的 prompt** 上；入边的上游图片作参考图）。
- \`video_gen\`：生视频节点（同上：自己的 prompt + 入边参考图）。
- \`video_concat\`：把多段上游视频按入边顺序拼成一条（不调生成模型）。
连线只表示**参考图**的流向 A→B（A 是 B 的上游输入），**提示词不走连线**。典型工作流：image_gen(出图) → video_gen(成片)，或 image_upload → image_gen(图生图)。

## 工作方式（持续执行 + 规划）
1. 先用 \`write_todos\` 把目标拆成有序步骤（如：设计分镜 → 建生图节点并写好 prompt → 触发生图 → 建生视频节点、连上参考图并写好 prompt → 触发生视频）。逐步推进，完成一步标记一步。
2. **画布当前状态（全部节点/连线/节点 id + 放置安全区）会作为「当前画布实时状态」消息自动注入到对话里——画布一有变化就追加一份最新的，因此对话中可能存在多份：一律以出现在最后的那一份为准（更靠前的都是已过期的历史快照）。没有新追加即表示画布未变、最后那份依然有效。直接读它，无需调用任何工具查询画布。**
3. 用 \`add_node\` / \`connect_nodes\` / \`update_node\` 搭建结构。**新节点的位置(x,y)必须放进「放置安全区」给出的坐标范围**（现有节点的右侧或下方），否则会与已有节点重叠。需要**重排/挪动已有节点**时，用 \`update_node\` 带上新的 x/y（同样放进安全区，避免重叠）。
4. 生成节点建好、\`prompt\` 写好后，用 \`generate_media_node\` 触发实际生成——提示词取该节点自己的 prompt，参考图自动沿入边收集上游已完成的图片版本。生成是异步的：触发后立即返回，卡片状态会自动更新，**不要轮询或重复触发同一节点**。
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
- 画布状态已自动注入（见「当前画布实时状态」），**不要调用工具查询画布**；\`add_node\`/\`connect_nodes\` 的返回值也已含 nodeId/edgeId，直接用。
- \`write_todos\` 用来维护同一份计划的状态推进（pending→in_progress→completed），**不要反复整表重写计划**。
- 触发生成前确保该 image_gen/video_gen 节点已写好 prompt。\`generate_media_node\` **自身已内建"请用户确认"环节**（同 clear_canvas）——需要生成时**直接调用它**即可，**绝不要先用 \`ask_user\` 问"要不要生成 / 确认生成吗"**；被拒绝即用户放弃该次生成，不要重试或绕道。
- 不确定的关键选择（而非细枝末节）才用 ask_user，避免频繁打断。`;

/** 运行时 context：activePlan（跨轮计划回注）+ userId + sessionId。 */
const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string(),
  sessionId: z.string(),
});

/**
 * 计划延续中间件：把既有任务计划作为一条消息写进 state（**不是** concat 进系统提示 —— 那会让计划
 * 一变就冲掉整段历史的 prompt cache，推导见 canvas-state-injection.buildPlanUpdate）。
 *
 * ⚠️ contextSchema 必不可少：beforeModel/afterModel 收到的 runtime.context 由 MiddlewareNode
 * **按本中间件自己声明的 contextSchema 过滤**（middleware.js: `let filteredContext = {}`，
 * 没有 schema 就一个字段都不给）。漏了它，activePlan 恒为 undefined、计划静默不注入——
 * 不会报错、测试也照过，只有让 agent 复述画布/计划才看得出来。
 * （wrapModelCall 不受此限：AgentNode 直接把完整 context 给它，所以改造前的写法能工作。）
 */
const planContinuationMiddleware = createMiddleware({
  name: 'canvasPlanContinuationMiddleware',
  contextSchema: z.object({ activePlan: z.string().optional() }),
  beforeModel: (state, runtime) =>
    buildPlanUpdate(state, runtime.context.activePlan),
});

/**
 * 模型标识解析（与 agent.factory 同策略）。画布用**独立**的 CANVAS_MODEL env，
 * 不复用现有 agent 的 GOOGLE_GENAI_MODEL —— 换画布模型不波及主 agent。
 * 默认 gemini-3.1-pro-preview（3.1 里能做对话的强模型；3.1-flash 不存在=404、3.1-flash-lite 执行力弱）。
 */
export function resolveCanvasModelName(model?: string | null): string {
  return model ?? process.env.CANVAS_MODEL ?? 'gemini-3.1-pro-preview';
}

function resolveChatModel(
  model?: string,
  thinkingLevel?: CanvasThinkingLevel | null,
) {
  const name = resolveCanvasModelName(model);
  // 思考深度按模型能力映射成各家参数（deepseek 只有开关、gemini 支持分级，见 thinking-level.ts）
  const thinking = thinkingModelParams(name, thinkingLevel);
  if (name.includes(':')) return initChatModel(name, thinking);
  return initChatModel(name, { modelProvider: 'google-genai', ...thinking });
}

export interface BuildCanvasAgentOptions {
  checkpointer?: unknown;
  systemPromptExtra?: string;
  model?: string;
  /** 思考深度档位（会话级）；null/缺省 = 跟随模型默认。 */
  thinkingLevel?: CanvasThinkingLevel | null;
  /** 敏感操作审批模式（会话级）；auto = 不设任何中断，一路做完。缺省 review。 */
  approvalMode?: CanvasApprovalMode;
  /**
   * 显式缓存生效时回填缓存的真实 token 数。worker 用它校正 token 会计
   * （provider 报的 cache_read 在显式缓存下被重复累加，不可直接用）。
   */
  onExplicitCacheTokens?: (tokens: number) => void;
  /** 画布操作工具（worker 闭包注入 sessionId/userId）。 */
  tools: unknown[];
  /**
   * 实时画布上下文提供器：模型调用前按 sessionId 取「当前节点/连线 + 放置安全区」文本，
   * 画布有变化时作为一条消息写进 state。让 agent 始终拿到最新画布，无需调用 get_canvas。
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

/**
 * 显式缓存中间件（默认关，env `CANVAS_EXPLICIT_CACHE=1` 开）。返回 null 表示不挂载。
 *
 * 形态被 Gemini API 逼定：请求侧必须清空 tools、工具声明搬进 CachedContent，
 * 推导与实测数据见 explicit-cache.ts 顶部注释。
 *
 * 每一步都能降级回隐式缓存（原样透传 request），开关开着也不会让整轮跑挂。
 */
/**
 * 显式缓存登记簿按**模块级**共享：canvas 的 system prompt 与工具集在所有会话间是同一份，
 * 缓存能跨 run / 跨会话复用，不必每轮重建（重建要花一次 create 调用 + 存储费）。
 */
const explicitCacheRegistry = new ExplicitCacheRegistry();

function buildExplicitCacheMiddleware(
  modelName: string,
  thinking: Record<string, unknown>,
  /** 缓存生效时回填其真实 token 数，供 token 会计校正 provider 的重复累加值。 */
  onCacheTokens?: (tokens: number) => void,
) {
  // 只对 Gemini 生效：DeepSeek 没有这套 CachedContent API，且它的隐式缓存本来就有 ~97%
  if (!isExplicitCacheEnabled() || modelName.includes(':')) return null;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const registry = explicitCacheRegistry;
  const ttl = explicitCacheTtlSeconds();
  const threshold = rebuildThresholdChars();
  const ai = new GoogleGenAI({ apiKey });
  const logger = new Logger('CanvasExplicitCache');
  /**
   * 本次运行的缓存状态。跟随式下缓存内容含对话历史，因此 per-run 唯一，不跨会话复用。
   * 运行结束不主动删除——靠 TTL 自然过期（没有 run 结束钩子可挂）。
   */
  let current: { name: string; tokens: number; upTo: number } | null = null;

  return createMiddleware({
    name: 'canvasExplicitCacheMiddleware',
    wrapModelCall: (async (
      request: {
        systemMessage?: { text?: string };
        tools?: readonly unknown[];
        messages?: readonly unknown[];
      },
      handler: (req: unknown) => Promise<unknown>,
    ) => {
      const systemPrompt = request.systemMessage?.text ?? '';
      const decls = toFunctionDeclarations(request.tools ?? []);
      // 没 system prompt / 工具声明转不出来 → 降级（宁可不缓存，也不能喂错的工具签名）
      if (!systemPrompt || !decls?.length) return handler(request);

      // 跟随式：把已完成的历史一起缓存，命中量随会话增长而不是钉死在固定前缀。
      // 攒够增量才重建（重建要花一次 create 调用 + 按 token-hour 的存储费）。
      const messages = request.messages ?? [];
      const plan = planFollowingCache(messages, current?.upTo ?? 0, threshold);
      if (plan) {
        try {
          const created = await ai.caches.create({
            model: modelName,
            config: {
              // 历史以纯文本拼在 system prompt 之后——不复刻 langchain 的原生 contents
              // 格式（那要固化 thoughtSignature 之类的内部常量，详见 explicit-cache.ts）
              systemInstruction: plan.transcript
                ? `${systemPrompt}\n\n${plan.transcript}`
                : systemPrompt,
              tools: [{ functionDeclarations: decls }],
              ttl: `${ttl}s`,
            },
          });
          const tokens = created.usageMetadata?.totalTokenCount ?? 0;
          // 没名字或大小未知就别用：会计拿不到真实命中量，宁可走隐式缓存
          if (created.name && tokens > 0) {
            const stale = current?.name;
            current = { name: created.name, tokens, upTo: plan.splitAt };
            registry.set(
              cacheKey(modelName, plan.transcript, decls),
              created.name,
              tokens,
              ttl,
            );
            logger.log(
              `显式缓存已建 model=${modelName} tokens=${tokens} 覆盖消息=${plan.splitAt} ttl=${ttl}s`,
            );
            // 旧缓存立刻删掉，别让它挂着继续计存储费
            if (stale) {
              await ai.caches
                .delete({ name: stale })
                .catch(() => logger.warn('旧缓存删除失败，等其 TTL 过期'));
            }
          }
        } catch (err) {
          // 常见原因：内容不够最小 token 门槛、配额、模型不支持 → 静默降级
          logger.warn(
            `显式缓存创建失败，降级隐式缓存: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
          );
        }
      }
      const entry = current;
      if (!entry) return handler(request);

      // 换一个绑定了缓存的实例，不去 mutate 共享 model（降级重试时才能干净回退）
      const cachedModel = new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey,
        ...thinking,
      });
      cachedModel.useCachedContent({
        name: entry.name,
        model: `models/${modelName}`,
        contents: [], // 类型上必需；运行时 langchain 只用 name 绑定缓存
      });
      // 告知会计层这次命中的真实大小（provider 报的 cache_read 被流式聚合累加过，不可用）
      onCacheTokens?.(entry.tokens);

      try {
        // tools 与 systemMessage 都必须清空——Gemini 的原话是
        // 「CachedContent can not be used with GenerateContent request setting
        //  system_instruction, tools or tool_config」。两者都已进缓存，再随请求发就 400。
        // systemMessage 置空文本即可：AgentNode 只在 text 非空时才把它塞进 messages。
        // messages 只发未缓存的尾部，否则历史会重复一份。
        return await handler({
          ...request,
          model: cachedModel,
          tools: [],
          systemMessage: new SystemMessage(''),
          messages: messages.slice(entry.upTo),
        });
      } catch (err) {
        if (isCacheInvalidError(err)) {
          current = null;
          logger.warn('显式缓存已失效，本次降级隐式缓存并将重建');
          return handler(request);
        }
        throw err;
      }
    }) as never,
  });
}

export async function buildCanvasAgent(
  opts: BuildCanvasAgentOptions,
): Promise<BuiltCanvasAgent> {
  const model = await resolveChatModel(opts.model, opts.thinkingLevel);

  // 实时画布状态中间件：模型调用前按 sessionId 取最新「节点/连线 + 安全区」，**画布有变化时**才作为
  // 一条新消息写进 state（闭包 opts.liveCanvasContext，worker 用 CanvasService 提供）。
  //
  // 两条都是为了 prompt cache，别改动（详细推导见 canvas-state-injection.ts 顶部注释）：
  // 1) 不能 concat 进 systemMessage —— system prompt 排在 messages 之前，一变则整段历史全失效。
  // 2) 必须用 beforeModel 而非 wrapModelCall —— wrapModelCall 改的 request 不写回 state，注入的
  //    快照下次调用就消失，导致每轮都在前缀末尾分叉、白付一份全量画布状态。
  // 换 beforeModel 的代价是 context 要自己声明 contextSchema，见下方注释。
  const canvasStateMiddleware = createMiddleware({
    name: 'canvasLiveStateMiddleware',
    // 必须声明：否则 runtime.context 被过滤成空对象，sessionId 恒 undefined、画布静默不注入
    // （同 planContinuationMiddleware 的告警）
    contextSchema: z.object({ sessionId: z.string() }),
    beforeModel: (state, runtime) =>
      buildCanvasStateUpdate(
        state,
        runtime.context.sessionId,
        opts.liveCanvasContext,
      ),
  });

  // guardrails：长跑需较高上限，触顶优雅结束（end）而非抛错。中间件顺序即 recency，
  // planContinuation / canvasState 靠后离模型最近；实时画布状态排最后，模型读到的最新鲜。
  // 这两个都用 beforeModel 把内容写进 state（append-only 保 prompt cache），顺序即消息追加顺序。
  // 注：不再对 delete_node 设每轮上限——那会把合法的"删除多个/全部节点"也卡死（只删了一部分）。
  // "删除所有"改用 clear_canvas 一次清空（需用户确认）；防"建了又全删"thrashing 交给系统提示。
  // 显式缓存排最内层：要拿到最终的 systemMessage 与工具集才能算缓存身份。
  // 默认不挂（开关关闭时返回 null，数组里连位置都不占，零开销）。
  const resolvedModel = resolveCanvasModelName(opts.model);
  const explicitCache = buildExplicitCacheMiddleware(
    resolvedModel,
    thinkingModelParams(resolvedModel, opts.thinkingLevel),
    opts.onExplicitCacheTokens,
  );

  // 内容块净化：会话换过模型时，checkpoint 里留着上一家的原生内容块（thinking / functionCall …），
  // OpenAI 兼容端会 400（详见 portable-content.ts）。只在收不下这些块的 provider 上挂，
  // Gemini 一侧零改动——那些块本来就是它产的，thoughtSignature 还必须原样回传。
  // 用 wrapModelCall 而不是 beforeModel：这是「发送前」的一次性变换，不该写回 state
  // （思考过程还要留给 checkpoint 与前端展示）。每轮剥法一致，前缀逐字稳定，不伤 prompt cache。
  const contentSanitizer = keepsNativeBlocks(resolvedModel)
    ? null
    : createMiddleware({
        name: 'portableContentMiddleware',
        wrapModelCall: (request, handler) =>
          handler({
            ...request,
            messages: stripNonPortableBlocks(request.messages),
          }),
      });

  const middleware = [
    modelCallLimitMiddleware({ threadLimit: 500, exitBehavior: 'end' }),
    toolCallLimitMiddleware({ threadLimit: 2000, exitBehavior: 'continue' }),
    planContinuationMiddleware,
    canvasStateMiddleware,
    ...(explicitCache ? [explicitCache] : []),
    // 排最内层：净化的是真正发出去的那一份，后面不再有人能把私有块加回来
    // （与 explicitCache 互斥——那个只对 Gemini 生效，此处只对非 Gemini 生效）
    ...(contentSanitizer ? [contentSanitizer] : []),
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
    // 审批模式（会话级）。auto：整个 interruptOn 都不给——一旦留下任何一项，
    // agent 还是会在那里停下等人，就不叫全自动了。
    // review（默认）：破坏性与消耗性操作暂停等确认，需要澄清时也能等人回答。
    ...(opts.approvalMode === 'auto'
      ? {}
      : {
          interruptOn: {
            ask_user: { allowedDecisions: ['edit', 'reject'] },
            // 清空画布有破坏性 → 暂停等用户 approve/reject（approve 才执行清空）
            clear_canvas: { allowedDecisions: ['approve', 'reject'] },
            // 生成消耗配额/时间 → 不自动执行，弹确认（approve 才真正触发生成）
            generate_media_node: { allowedDecisions: ['approve', 'reject'] },
          },
        }),
    checkpointer: opts.checkpointer as never,
  });
}
