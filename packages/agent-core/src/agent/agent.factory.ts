import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { initChatModel } from 'langchain/chat_models/universal';
import {
  type AnyBackendProtocol,
  createDeepAgent,
  type SubAgent,
} from 'deepagents';
import {
  type AgentMiddleware,
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from 'langchain';
import { z } from 'zod';
import {
  createDynamicContextMiddleware,
  type DynamicContextProvider,
} from '../modes/dynamic-context';
import type { SubagentSpec } from '../modes/resolve-mode';
import type { ToolInterruptOn } from '../modes/tool-registry';
import { injectSkillReadPolicy } from './plan-injection';
import { keepsNativeBlocks, stripNonPortableBlocks } from './portable-content';
import { type ThinkingLevel, thinkingModelParams } from './thinking-level';
import { resolveModelName } from './models';
import { askUserTool } from './tools/ask-user.tool';
import { recoverInvalidToolCalls } from './invalid-tool-calls';
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

/** 模型给出的工具参数不是合法 JSON（invalid_tool_calls）→ 修复或让模型重给，不让本轮静默结束（见 invalid-tool-calls.ts） */
const invalidToolCallMiddleware = createMiddleware({
  name: 'invalidToolCallMiddleware',
  wrapModelCall: (request, handler) =>
    recoverInvalidToolCalls(request, async (r) => handler(r)),
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
export function resolveChatModel(
  model?: string | null,
  thinkingLevel?: ThinkingLevel | null,
): Promise<BaseChatModel> {
  const name = resolveModelName(model);
  const thinking = thinkingModelParams(name, thinkingLevel);
  if (name.includes(':')) return initChatModel(name, thinking);
  return initChatModel(name, { modelProvider: 'google-genai', ...thinking });
}

/** 解析好的模型：实例 + 能否原样收下历史里的 provider 原生内容块（只有 Gemini 能，见 portable-content.ts） */
export interface ResolvedModel {
  model: BaseChatModel;
  keepsNativeBlocks: boolean;
}

/**
 * 按引用解析模型。缺省按 `provider:model` 名字解析（web：env 里的 Key + 白名单）；desktop 传自己的解析器，
 * 引用是「连接 id/模型 id」，Key 与 Base URL 来自用户配置的连接（见 providers/）。
 */
export type ModelResolver = (
  ref: string | null | undefined,
  thinkingLevel?: ThinkingLevel | null,
) => Promise<ResolvedModel>;

const resolveByName: ModelResolver = async (ref, thinkingLevel) => ({
  model: await resolveChatModel(ref, thinkingLevel),
  keepsNativeBlocks: keepsNativeBlocks(resolveModelName(ref)),
});

/**
 * 内容块净化（与画布同一套，见 portable-content.ts）：非 Gemini 模型收不下 checkpoint 里的
 * provider 原生块与工具结果里的 image 块，会整轮 4xx 且每轮重放。只改发给模型的那一份。
 */
function portableContentMiddleware(keepsNative: boolean) {
  if (keepsNative) return null;
  return createMiddleware({
    name: 'portableContentMiddleware',
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        messages: stripNonPortableBlocks(request.messages),
      }),
  });
}

const HITL_DECISIONS = ['approve', 'edit', 'reject'] as const;
type HitlDecision = (typeof HITL_DECISIONS)[number];
const isHitlDecision = (d: string): d is HitlDecision =>
  (HITL_DECISIONS as readonly string[]).includes(d);

/** 审批表收窄成 HITL 中间件认的决策集（子 agent 的 interruptOn 类型比主 agent 严格） */
function hitlTable(
  table: Record<string, boolean | { allowedDecisions: string[] }>,
): Record<string, boolean | { allowedDecisions: HitlDecision[] }> {
  return Object.fromEntries(
    Object.entries(table).map(([name, v]) => [
      name,
      typeof v === 'boolean'
        ? v
        : { allowedDecisions: v.allowedDecisions.filter(isHitlDecision) },
    ]),
  );
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
  /**
   * 技能库目录（agent 眼中的路径），deepagents skills 中间件扫它。
   * 不传 = 不挂技能：没有 skills 中间件，也不注入「引用文件必读」规则（如设计 agent）。
   */
  skillsDir?: string;
  /** 内置 ask_user（HITL 提问）；缺省开。全自动、不接 checkpointer 的宿主（设计 agent）传 false */
  askUser?: boolean;
  /**
   * 口子：宿主自己的中间件（如设计 agent 把预览图补成用户消息），排在守护之后、core 内置中间件之前。
   */
  middleware?: readonly AgentMiddleware[];
  /** `provider:model`（见 models.ts 白名单）；裸名按 google-genai 兼容处理；缺省回退 env / 默认 */
  model?: string;
  /** 口子：已构造好的模型实例（explicit cache 之类的包装留给宿主做）；给了就忽略 model / thinkingLevel */
  modelInstance?: BaseChatModel;
  /**
   * 口子：按引用解析模型（主 agent 的 model 与子 agent 的模型都经它）；缺省按 `provider:model` 名字解析。
   * desktop 传连接解析器（引用为「连接 id/模型 id」）。
   */
  resolveModel?: ModelResolver;
  /** 思考深度档位；缺省 / null = auto */
  thinkingLevel?: ThinkingLevel | null;
  /** RedisSaver / SqliteSaver；配 interruptOn 审批时必须传 */
  checkpointer?: unknown;
  /** 每次模型调用前取的动态上下文（计划、媒体清单、MCP app 上下文、画布状态……） */
  dynamicContext?: readonly DynamicContextProvider[];
  /** 口子：失控守护 */
  guardrails?: AgentGuardrails;
  /**
   * instantiateTools 产出的子 agent（模式勾选的其它模式）。主 agent 经 task 工具委派；deepagents 内置的
   * general-purpose 子 agent 照常存在。子 agent 的审批 = 自己工具的审批表 + interruptOnOverride
   * （desktop 的权限档位对子 agent 的写 / 执行同样生效）。
   */
  subagents?: readonly SubagentSpec[];
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
 *   守护（guardrails）→ 宿主中间件 → 动态上下文（计划等）→ 技能必读规则（离模型最近，有技能才挂）
 *   → 内容块净化（作用于最终发出的消息）→ 坏工具调用自愈（紧贴模型）→ 工具入参自愈
 */
export async function buildAgent(opts: BuildAgentOptions): Promise<BuiltAgent> {
  const resolve = opts.resolveModel ?? resolveByName;
  // 宿主给的实例认不出 provider：保守地一律净化
  const main: ResolvedModel = opts.modelInstance
    ? { model: opts.modelInstance, keepsNativeBlocks: false }
    : await resolve(opts.model, opts.thinkingLevel);
  const model = main.model;
  const contentSanitizer = portableContentMiddleware(main.keepsNativeBlocks);

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
    ...(opts.middleware ?? []),
    createDynamicContextMiddleware(opts.dynamicContext ?? []),
    ...(opts.skillsDir ? [skillReadPolicyMiddleware] : []),
    ...(contentSanitizer ? [contentSanitizer] : []),
    // 紧贴模型：坏工具调用在响应写进 state 之前修好，HITL 审批与路由看到的已是修好的调用
    invalidToolCallMiddleware,
    // 最内层：先于 deepagents 的中间件接住工具入参校验错误
    toolInputRecoveryMiddleware,
  ];

  const askUser = opts.askUser !== false;
  // 宿主的审批表：装配表 + 运行期覆盖（同名以覆盖为准）
  const hostInterruptOn = { ...opts.interruptOn, ...opts.interruptOnOverride };
  // 一项审批都没有就不挂 HITL 中间件（它在没有 checkpointer 时也无从中断）
  const needsHitl = askUser || Object.keys(hostInterruptOn).length > 0;
  const skillSources = opts.skillsDir
    ? [`${opts.skillsDir.replace(/\/+$/, '')}/`]
    : undefined;

  const subagents: SubAgent[] = [];
  for (const spec of opts.subagents ?? []) {
    // 与主 agent 同一个模型就复用实例（带着本会话的思考档位）
    const sameModel =
      spec.model === null ||
      (!opts.modelInstance &&
        resolveModelName(spec.model) === resolveModelName(opts.model));
    const sub = sameModel ? main : await resolve(spec.model, null);
    const subInterruptOn = hitlTable({
      ...spec.interruptOn,
      ...opts.interruptOnOverride,
    });
    const sanitizer = portableContentMiddleware(sub.keepsNativeBlocks);
    subagents.push({
      name: spec.name,
      description: spec.description,
      systemPrompt: spec.systemPrompt,
      tools: [...spec.tools] as never[],
      model: sub.model,
      middleware: [
        ...(sanitizer ? [sanitizer] : []),
        invalidToolCallMiddleware,
        toolInputRecoveryMiddleware,
      ],
      // 没有自己的审批项就不传：deepagents 让子 agent 继承主 agent 的审批表（含宿主覆盖）
      ...(Object.keys(subInterruptOn).length > 0 && {
        interruptOn: subInterruptOn,
      }),
      ...(spec.skills && skillSources && { skills: skillSources }),
    });
  }

  return createDeepAgent({
    model,
    systemPrompt: opts.systemPrompt,
    tools: (askUser
      ? [askUserTool, ...opts.tools]
      : [...opts.tools]) as never[],
    backend: opts.backend,
    skills: skillSources,
    subagents,
    contextSchema,
    middleware,
    // ask_user 只允许两种决策：approve=采纳建议答案；edit=前端把用户答案写进 args.answers 后执行。
    // 不提供 reject——对「提问」语义无意义。
    interruptOn: needsHitl
      ? {
          ...hostInterruptOn,
          ...(askUser
            ? { ask_user: { allowedDecisions: ['approve', 'edit'] } }
            : {}),
        }
      : undefined,
    checkpointer: opts.checkpointer as never,
  });
}
