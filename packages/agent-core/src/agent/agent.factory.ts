import { initChatModel } from 'langchain/chat_models/universal';
import { createDeepAgent, StateBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { injectActivePlan, injectSkillReadPolicy } from './plan-injection';
import { keepsNativeBlocks, stripNonPortableBlocks } from './portable-content';
import { type ThinkingLevel, thinkingModelParams } from './thinking-level';
import { resolveModelName } from './models';
import { askUserTool } from './tools/ask-user.tool';
import { getWeatherTool } from './tools/get-weather.tool';
import { composeSystemPrompt } from './system-prompt';

// ─────────────────────────────────────────────────────────────────────────────
// Context schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行时 context schema：
 * - activePlan：worker 经 `context.activePlan` 传入「当前任务计划」文本。
 * - userId：必填。技能库按用户隔离（StoreBackend namespace = [userId, 'skills']），
 *   缺失即 schema 校验报错（双保险：namespace factory 内还有 throw 守卫，杜绝静默共享技能库）。
 */
const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 内置中间件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计划延续中间件：把 worker 经 runtime context 传入的「当前任务计划」追加到系统提示**末尾**。
 *
 * deepagents 内置 todoListMiddleware 会往系统提示追加一段鼓励「随时重订计划」的说明，多轮里这会
 * 诱导模型整表重写 todos、把没做完的步骤冲掉。createDeepAgent 的 middleware 数组里，自定义中间件
 * 排在 todoListMiddleware 之后 = 更内层，其 systemMessage.concat 发生得更晚 = 离模型最近
 * （recency）。把「沿用既定计划、勿整表重写」放在最后，才能盖过那句「随时重订」。注入逻辑见
 * plan-injection.ts，计划文本由 worker 从 DB 算出（见 agent.processor.buildActivePlan）。
 */
const planContinuationMiddleware = createMiddleware({
  name: 'planContinuationMiddleware',
  wrapModelCall: injectActivePlan as never,
});

/**
 * 杠杆3：把「引用文件必读」硬规则注入系统提示末尾（recency 最强位置），提升 SKILL.md 里
 * references/sub-skill 的按需 read_file 触发率。逻辑见 plan-injection.injectSkillReadPolicy。
 */
const skillReadPolicyMiddleware = createMiddleware({
  name: 'skillReadPolicyMiddleware',
  wrapModelCall: injectSkillReadPolicy as never,
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型解析（LangChain initChatModel 多提供商动态切换）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把模型标识解析为 LangChain Chat Model：
 * - `provider:model`（如 `deepseek:deepseek-flash` / `google-genai:gemini-3.8-flash`）
 *   → initChatModel 按前缀动态加载对应 provider 包；
 * - 裸名（旧 DB 会话、env GOOGLE_GENAI_MODEL 的存量值）→ 兼容回退 google-genai
 *   （不能靠 initChatModel 自动推断：它会把 `gemini-*` 推到 google-vertexai）。
 * API key 由各 provider 包从 env 自取（GOOGLE_API_KEY / DEEPSEEK_API_KEY）。
 * 思考深度档位在这里映射成模型参数；该模型不支持的档位静默回落 auto（见 thinkingModelParams）。
 */
function resolveChatModel(
  model?: string,
  thinkingLevel?: ThinkingLevel | null,
) {
  const name = resolveModelName(model);
  // 思考深度按模型能力映射成各家参数（deepseek 只有开关、gemini 支持分级，见 thinking-level.ts）
  const thinking = thinkingModelParams(name, thinkingLevel);
  if (name.includes(':')) return initChatModel(name, thinking);
  return initChatModel(name, { modelProvider: 'google-genai', ...thinking });
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildAgentOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildAgentOptions {
  /** RedisSaver 实例；配 interruptOn 审批时必须传。 */
  checkpointer?: unknown;
  /** 追加到系统提示末尾（如 /command 强制使用某技能的指令）。 */
  systemPromptExtra?: string;
  /**
   * 本次回答模型（前端可切换），`provider:model` 形式（见 models.ts 白名单）；
   * 裸名按 google-genai 兼容处理；缺省时回退 env GOOGLE_GENAI_MODEL / 代码默认。
   */
  model?: string;
  /** 思考深度档位（前端可切换）；缺省/null = auto（跟随模型默认）。 */
  thinkingLevel?: ThinkingLevel | null;

  /**
   * 默认 backend（agent 文件工具/skills/execute 的落点）。沙箱模式传 GuardedSandbox 实例；
   * 缺省 = new StateBackend()（无沙箱：无技能、无 execute）。
   * 标记 unknown 以避免引入 deepagents 类型到调用方，worker 层直接传实例即可。
   */
  defaultBackend?: unknown;
  /**
   * 是否为沙箱模式（对应 Daytona / E2B 沙箱 backend）。
   * true → 追加沙箱系统提示区块（execute 守则）。技能文件由 worker 在调用前写入沙箱盘。
   * 缺省 = false。
   */
  hasSandbox?: boolean;
  /**
   * 沙箱模式下 agent 眼中的工作区路径（GuardedSandbox.visibleRoot，正常为 /workspace）。
   * 系统提示里的路径与技能库扫描目录（`${workspace}/skills/`）都由它决定。
   */
  workspace?: string;
  /**
   * 宿主专属的系统提示段落，接在通用段之后（backend 传生图 / 配音 / 附件等说明，见 backend-prompt.ts）。
   */
  hostPromptSections?: string;
  /**
   * 有工作区时追加的执行区块（backend 传沙箱区块，desktop 传本机工作区区块）。
   * 仅在 hasSandbox 且 workspace 非空时生效。
   */
  workspacePromptBlock?: (workspace: string) => string;
  /**
   * 技能库扫描目录（agent 眼中的路径）；缺省 = `${workspace}/skills`。
   * desktop 的工作区是用户自选目录，技能放在应用管理的运行目录，经 CompositeBackend 路由挂载。
   */
  skillsDir?: string;
  /**
   * 业务工具（如 media 生图/生视频、send_email）由宿主闭包注入——agent 模块不依赖业务模块，
   * 耦合点收敛在宿主，保持 agent.factory 的低耦合边界。
   */
  extraTools?: unknown[];
  /**
   * 额外需要审批的工具（如 send_email、用户设为「需审批」的 MCP 工具、desktop 未信任工作区时的
   * execute），并进 interruptOn，走同一套 HITL 审批流。
   */
  extraInterruptOn?: Record<string, true>;
}

/**
 * buildAgent 对外暴露的最小 agent 接口：只声明 worker 实际调用的方法，
 * 避免把 deepagents 内部类型泄漏到调用方（保持 agent.factory 的低耦合边界），
 * 同时让调用点不再退化成 any。
 */
export interface BuiltAgent {
  stream(
    input: unknown,
    config?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
  getState(config: unknown): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAgent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装配主 agent：多提供商模型（initChatModel 动态切换）+ 内置工具 + get_weather + ask_user，
 * 其余工具（含需审批的 send_email）由宿主经 extraTools / extraInterruptOn 注入。
 *
 * Skills 来源：`${workspace}/skills/` 直接读 backend（沙箱模式下即沙箱磁盘的 `${workspaceRoot}/skills/`）。
 *   技能文件由 worker 在起沙箱后、调 LLM 前用 uploadSkillsToSandbox 写入沙箱盘（见 agent.processor），
 *   deepagents 的 skills 中间件在 beforeAgent 扫该目录即可读到。
 *   无沙箱（StateBackend 兜底）时为空 → 不提供任何技能（设计：无沙箱=无技能）。
 *
 * defaultBackend / hasSandbox 均可选，缺省 = new StateBackend()（无沙箱，无技能、无 execute）。
 */
export async function buildAgent(
  opts: BuildAgentOptions = {},
): Promise<BuiltAgent> {
  const model = await resolveChatModel(opts.model, opts.thinkingLevel);

  // backend = 沙箱（GuardedSandbox）或 StateBackend 兜底；技能库不单独路由到内存 store，
  // 直接读 backend：沙箱模式落在 ${workspaceRoot}/skills/，无沙箱则为空（不提供技能）。
  const backend =
    (opts.defaultBackend as StateBackend | undefined) ?? new StateBackend();

  // 内容块净化（与画布同一套，见 portable-content.ts）：非 Gemini 模型收不下 checkpoint 里的
  // provider 原生块（换过模型的 thinking / functionCall）与工具结果里的 image 块（read_file 读图片），
  // 会整轮 4xx 且每轮重放、会话永久跑不动。只改发给模型的那一份，不写回 state。
  const contentSanitizer = keepsNativeBlocks(resolveModelName(opts.model))
    ? null
    : createMiddleware({
        name: 'portableContentMiddleware',
        wrapModelCall: (request, handler) =>
          handler({
            ...request,
            messages: stripNonPortableBlocks(request.messages),
          }),
      });

  // 中间件顺序即 recency：计划延续 → 技能必读规则（离模型最近）；净化排最内层，作用于最终发出的消息。
  const middleware = [
    planContinuationMiddleware,
    skillReadPolicyMiddleware,
    ...(contentSanitizer ? [contentSanitizer] : []),
  ];

  return createDeepAgent({
    model,
    systemPrompt:
      composeSystemPrompt(opts.hasSandbox ? opts.workspace : undefined, {
        hostSections: opts.hostPromptSections,
        workspaceBlock: opts.workspacePromptBlock,
        skillsDir: opts.skillsDir,
      }) + (opts.systemPromptExtra ?? ''),
    tools: [
      getWeatherTool,
      askUserTool,
      ...((opts.extraTools ?? []) as never[]),
    ],
    backend,
    // 技能库扫描目录：沙箱工作区下的 skills/（无沙箱时 StateBackend 为空，不提供技能）
    skills: [
      opts.skillsDir
        ? `${opts.skillsDir}/`
        : opts.workspace
          ? `${opts.workspace}/skills/`
          : '/skills/',
    ],
    contextSchema,
    // 顺序即 recency：数组靠后 = 更内层 = systemMessage.concat 更晚 = 离模型更近。
    middleware,
    // ask_user 只允许两种决策：approve=采纳建议答案（原参执行）；edit=前端把用户答案
    // 写进 args.answers 后执行（本版 langchain HITL 无 respond，用 edit 承载用户答案）。
    // 不提供 reject——对「提问」语义无意义（设计 §已确认的需求决策）。
    interruptOn: {
      ...opts.extraInterruptOn,
      ask_user: { allowedDecisions: ['approve', 'edit'] },
    },
    checkpointer: opts.checkpointer as never,
  });
}
