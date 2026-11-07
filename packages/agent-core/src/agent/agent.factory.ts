import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { initChatModel } from 'langchain/chat_models/universal';
import { type AnyBackendProtocol, createDeepAgent } from 'deepagents';
import {
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from 'langchain';
import { z } from 'zod';
import {
  createDynamicContextMiddleware,
  type DynamicContextProvider,
} from '../modes/dynamic-context';
import type { ToolInterruptOn } from '../modes/tool-registry';
import { injectSkillReadPolicy } from './plan-injection';
import { keepsNativeBlocks, stripNonPortableBlocks } from './portable-content';
import { type ThinkingLevel, thinkingModelParams } from './thinking-level';
import { resolveModelName } from './models';
import { askUserTool } from './tools/ask-user.tool';
import { recoverToolInputError } from './tool-input-recovery';

// ─────────────────────────────────────────────────────────────────────────────
// Context schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行时 context schema：
 * - activePlan：worker 经 `context.activePlan` 传入「当前任务计划」文本（activePlanProvider 读）。
 * - userId：必填（thread 作用域、审计），缺失即 schema 校验报错。
 */
const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 内置中间件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 杠杆3：把「引用文件必读」硬规则注入系统提示末尾（recency 最强位置），提升 SKILL.md 里
 * references/sub-skill 的按需 read_file 触发率。逻辑见 plan-injection.injectSkillReadPolicy。
 */
const skillReadPolicyMiddleware = createMiddleware({
  name: 'skillReadPolicyMiddleware',
  wrapModelCall: injectSkillReadPolicy as never,
});

/** 工具入参校验不过 → 把问题回给模型改参重试，而不是整轮失败（见 tool-input-recovery.ts） */
const toolInputRecoveryMiddleware = createMiddleware({
  name: 'toolInputRecoveryMiddleware',
  wrapToolCall: recoverToolInputError,
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
  const thinking = thinkingModelParams(name, thinkingLevel);
  if (name.includes(':')) return initChatModel(name, thinking);
  return initChatModel(name, { modelProvider: 'google-genai', ...thinking });
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildAgentOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentGuardrails {
  /** 单个 thread 的模型调用上限，超出即结束本轮（防失控长跑） */
  modelCallLimit?: number;
  /** 单个 thread 的工具调用上限，超出后不再执行工具但继续让模型收尾 */
  toolCallLimit?: number;
}

/**
 * 装配参数全部来自 resolveMode / instantiateTools / mountSkills 的产物，buildAgent 本身不再拼提示词、
 * 不再认识任何宿主工具——它只负责把「模式装配结果」交给 deepagents，并挂上 core 的内置中间件。
 */
export interface BuildAgentOptions {
  /** resolveMode 产出的系统提示（宿主可在其后接 run 内稳定的静态尾段，如 /command 激活技能全文） */
  systemPrompt: string;
  /** instantiateTools 产出的工具（内置 ask_user 由这里追加，宿主不用传） */
  tools: readonly StructuredToolInterface[];
  /** instantiateTools 产出的审批表 */
  interruptOn?: Record<string, ToolInterruptOn>;
  /**
   * 口子：宿主按运行期策略覆盖 / 追加审批（如 desktop 按权限档位让内置 execute / write_file 走审批，
   * 或画布按 approvalMode 决定哪些工具要确认）。同名以这里为准。
   */
  interruptOnOverride?: Record<
    string,
    boolean | { allowedDecisions: string[] }
  >;
  /** mountSkills 产出的 backend（沙箱 / CompositeBackend / desktop 本机目录） */
  backend: AnyBackendProtocol;
  /** 技能库目录（agent 眼中的路径），deepagents skills 中间件扫它 */
  skillsDir: string;
  /** `provider:model`（见 models.ts 白名单）；裸名按 google-genai 兼容处理；缺省回退 env / 默认 */
  model?: string;
  /** 口子：已构造好的模型实例（explicit cache 之类的包装留给宿主做）；给了就忽略 model / thinkingLevel */
  modelInstance?: BaseChatModel;
  /** 思考深度档位；缺省 / null = auto */
  thinkingLevel?: ThinkingLevel | null;
  /** RedisSaver / SqliteSaver；配 interruptOn 审批时必须传 */
  checkpointer?: unknown;
  /** 每次模型调用前取的动态上下文（计划、媒体清单、MCP app 上下文、画布状态……） */
  dynamicContext?: readonly DynamicContextProvider[];
  /** 口子：失控守护 */
  guardrails?: AgentGuardrails;
}

/**
 * buildAgent 对外暴露的最小 agent 接口：只声明 worker 实际调用的方法，
 * 避免把 deepagents 内部类型泄漏到调用方，同时让调用点不再退化成 any。
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
 * 装配主 agent：模型（实例或按名解析）+ 模式装配出的工具 + 内置 ask_user + 中间件链。
 *
 * 中间件顺序即 recency（数组靠后 = 更内层 = systemMessage.concat 更晚 = 离模型更近）：
 *   守护（guardrails）→ 动态上下文（计划等）→ 技能必读规则（离模型最近）→ 内容块净化（作用于最终发出的消息）
 */
export async function buildAgent(opts: BuildAgentOptions): Promise<BuiltAgent> {
  const model =
    opts.modelInstance ??
    (await resolveChatModel(opts.model, opts.thinkingLevel));

  // 内容块净化（与画布同一套，见 portable-content.ts）：非 Gemini 模型收不下 checkpoint 里的
  // provider 原生块与工具结果里的 image 块，会整轮 4xx 且每轮重放。只改发给模型的那一份。
  const nativeOk = opts.modelInstance
    ? false
    : keepsNativeBlocks(resolveModelName(opts.model));
  const contentSanitizer = nativeOk
    ? null
    : createMiddleware({
        name: 'portableContentMiddleware',
        wrapModelCall: (request, handler) =>
          handler({
            ...request,
            messages: stripNonPortableBlocks(request.messages),
          }),
      });

  const guardrails = [
    ...(opts.guardrails?.modelCallLimit
      ? [
          modelCallLimitMiddleware({
            threadLimit: opts.guardrails.modelCallLimit,
            exitBehavior: 'end',
          }),
        ]
      : []),
    ...(opts.guardrails?.toolCallLimit
      ? [
          toolCallLimitMiddleware({
            threadLimit: opts.guardrails.toolCallLimit,
            exitBehavior: 'continue',
          }),
        ]
      : []),
  ];

  const middleware = [
    ...guardrails,
    createDynamicContextMiddleware(opts.dynamicContext ?? []),
    skillReadPolicyMiddleware,
    ...(contentSanitizer ? [contentSanitizer] : []),
    // 最内层：先于 deepagents 的中间件接住工具入参校验错误
    toolInputRecoveryMiddleware,
  ];

  return createDeepAgent({
    model,
    systemPrompt: opts.systemPrompt,
    tools: [askUserTool, ...opts.tools] as never[],
    backend: opts.backend,
    skills: [`${opts.skillsDir.replace(/\/+$/, '')}/`],
    contextSchema,
    middleware,
    // ask_user 只允许两种决策：approve=采纳建议答案；edit=前端把用户答案写进 args.answers 后执行。
    // 不提供 reject——对「提问」语义无意义。
    interruptOn: {
      ...opts.interruptOn,
      ...opts.interruptOnOverride,
      ask_user: { allowedDecisions: ['approve', 'edit'] },
    },
    checkpointer: opts.checkpointer as never,
  });
}
