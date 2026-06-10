import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseStore } from '@langchain/langgraph';
import { CompositeBackend, createDeepAgent, StateBackend, StoreBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { buildSkillSyncFiles, ReadOnlyStoreBackend } from './skills-backend';
import { injectActivePlan, injectSkillReadPolicy } from './plan-injection';
import { getWeatherTool } from './tools/get-weather.tool';
import { sendEmailTool } from './tools/send-email.tool';

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示
// ─────────────────────────────────────────────────────────────────────────────

/** base 提示文本（VERBATIM — 措辞由后续任务优化，此处不改动内容）。 */
const BASE_SYSTEM_PROMPT = `你是一个动态加载skills的助手

## 斜杠命令（/command）
当用户**本轮**的请求以 \`/<技能名>\`（如 \`/tvc-director ...\`）开头时，这是显式指定要使用的技能：
按上面「Skills System」里对应技能的指示加载并遵循它的 SKILL.md，把 \`/\` 命令后面的文字当作该技能的输入；命令后无内容时，按该技能说明执行即可。

加载 SKILL.md **不等于**加载完毕：SKILL.md 只是技能的入口索引。读完它后，必须先判断**完成当前任务还需要哪些技能内部资源**，再用 \`read_file\` 按需把它们读进来，然后才动手：
- **reference 文档**：SKILL.md 里出现的 \`./references/*.md\`、\`references/*.md\` 等引用，尤其是被标注为「阶段前置 / 强制 / 必须先 read_file」的，必须在产出对应内容**之前**读取；
- **子技能（sub-skill）**：SKILL.md 用 markdown 链接（如 \`[xxx](./sub-skill.md)\`）路由到的子技能文件，命中该路由时才读取对应文件；
- **其它资产**：SKILL.md 指向的模板、词库、示例、图片等（如 \`./assets/*\`），按当前步骤实际需要再读。
原则是 progressive disclosure——**按需加载**：只读当前这一步真正用得到的资源，不要一次性把所有 reference 都读进来；但也**不要跳过**SKILL.md 明确要求前置读取的资源就直接产出。

注意：只对用户**当前这一轮**的请求这样做。历史对话里出现过、且其后已经有过助手回复的 \`/\` 命令，表示上一轮已经处理完毕，**不要再重新加载技能或重新执行**——除非用户本轮重新发起。`;

/** 沙箱可用时追加的额外系统提示区块。 */
const SANDBOX_SYSTEM_PROMPT_BLOCK = `

## 沙箱执行（execute）
- 技能 scripts/* 下的脚本可用 \`execute\` 在沙箱内运行（运行前请先阅读 SKILL.md 中对应脚本的运行说明）。
- 所需依赖可在沙箱内安装（如 pip install / npm install）。
- 产物文件应写入工作区（非 /skills/ 路径）。
- /skills/ 是只读技能库，禁止在 execute 里向 /skills/ 写入任何文件。`;

/**
 * 构建系统提示：base 文本 VERBATIM，沙箱区块仅在 hasSandbox=true 时追加。
 * 后续任务（提示优化 Task）可在此函数里调整措辞，不需要改业务逻辑。
 */
export function buildSystemPrompt(hasSandbox: boolean): string {
  return BASE_SYSTEM_PROMPT + (hasSandbox ? SANDBOX_SYSTEM_PROMPT_BLOCK : '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Context schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行时 context schema：
 * - activePlan：worker 经 `context.activePlan` 传入「当前任务计划」文本。
 * - userId：worker 传入的用户 ID（供 StoreBackend namespace factory 使用）。
 *   TODO(Task 10)：worker 接线任务会在 stream config 里传入 userId；
 *   namespace factory 内已有 throw 守卫，缺失时会在运行时抛出，而非静默共享技能库。
 *   此处标 optional 仅为保持旧 worker 调用点在过渡期内可以编译通过。
 */
const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string().optional(),
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
// BuildAgentOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildAgentOptions {
  /** RedisSaver 实例；配 interruptOn 审批时必须传。 */
  checkpointer?: unknown;
  /** 追加到系统提示末尾（如 /command 强制使用某技能的指令）。 */
  systemPromptExtra?: string;
  /** 本次回答模型（前端可切换）；缺省时回退 env GOOGLE_GENAI_MODEL / 代码默认。 */
  model?: string;

  // ── 过渡期软选项（Task 10 worker 接线任务会显式传入，此前保持旧调用点可编译）──
  /**
   * 默认 backend（/skills/ 以外的路径）。
   * 缺省 = new StateBackend()（与旧行为一致）。
   * 标记 unknown 以避免引入 deepagents 类型到调用方，worker 层直接传实例即可。
   */
  defaultBackend?: unknown;
  /**
   * LangGraph BaseStore 实例。
   * 传入后：技能同步中间件（skillSandboxSyncMiddleware）启用（前提是 hasSandbox 也为 true）；
   * StoreBackend namespace factory 的 store 由 deepagents 内部从 LangGraph exec ctx 读取。
   * 缺省 = undefined → 技能同步中间件跳过（旧行为）。
   */
  store?: BaseStore;
  /**
   * 是否为沙箱模式（对应 Daytona 沙箱 backend）。
   * true → 追加沙箱系统提示区块 + 启用 skillSandboxSyncMiddleware（需同时传 store）。
   * 缺省 = false（旧行为）。
   */
  hasSandbox?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAgent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装配主 agent：Gemini + 内置工具 + get_weather + 需审批的 send_email。
 *
 * Skills backend 路由：
 *   /skills/ → ReadOnlyStoreBackend（只读，防 agent 污染技能库）
 *   其余路径 → defaultBackend（StateBackend 或外部传入的沙箱 backend）
 *
 * 沙箱同步中间件（opts.store && opts.hasSandbox）：
 *   beforeAgent 钩子把当前用户的技能文件从 LangGraph store 同步到沙箱 backend，
 *   确保 agent 在沙箱内能通过 /skills/ 读到最新技能。
 *
 * 过渡期说明（Task 9 → Task 10）：
 *   defaultBackend / store / hasSandbox 均为可选，缺省值与旧行为完全一致，
 *   旧 worker 调用点（不传这三项）可正常编译。Task 10 worker 接线任务会显式传入。
 */
export function buildAgent(opts: BuildAgentOptions = {}): any {
  const model = new ChatGoogleGenerativeAI({
    model: opts.model ?? process.env.GOOGLE_GENAI_MODEL ?? 'gemini-3.5-flash',
    apiKey: process.env.GOOGLE_API_KEY,
  });

  // /skills/ 只读 backend：namespace factory 在运行时从 config.configurable.userId 取用户 ID。
  // dist 已核实：工厂入参是 { state, config, assistantId }，userId 走 config.configurable。
  const skillsBackend = new ReadOnlyStoreBackend({
    namespace: ({ config }: { config?: { configurable?: { userId?: string } } }) => {
      const userId = config?.configurable?.userId;
      if (!userId) {
        throw new Error(
          'configurable.userId 缺失：worker 必须在 stream config 传入（禁止静默共享技能库）',
        );
      }
      return [userId, 'skills'];
    },
  });

  // CompositeBackend：/skills/ → skillsBackend（只读），其余 → defaultBackend
  const defaultBackend = (opts.defaultBackend as StateBackend | undefined) ?? new StateBackend();
  const backend = new CompositeBackend(defaultBackend, { '/skills/': skillsBackend });

  // 沙箱技能同步中间件：仅当 store 和 hasSandbox 同时传入时启用
  const shouldSync = !!(opts.store && opts.hasSandbox);
  const skillSandboxSyncMiddleware = shouldSync
    ? createMiddleware({
        name: 'skillSandboxSyncMiddleware',
        // beforeAgent 签名：(state, runtime) => PromiseOrValue<MiddlewareResult<...>>
        // runtime.context 的形状由 contextSchema 推导，此处 cast 取 userId
        beforeAgent: async (
          _state: unknown,
          runtime: { context?: { userId?: string } },
        ): Promise<undefined> => {
          const userId = runtime.context?.userId;
          if (!userId) return undefined;
          const files = await buildSkillSyncFiles(opts.store!, userId);
          if (files.length > 0) {
            // uploadFiles 把技能文件注入 CompositeBackend 的 defaultBackend（沙箱 backend）
            await backend.uploadFiles(files);
          }
          return undefined;
        },
      })
    : null;

  // 中间件顺序：同步（最外层）→ 计划延续 → 技能必读规则（离模型最近）
  const middleware = [
    ...(skillSandboxSyncMiddleware ? [skillSandboxSyncMiddleware] : []),
    planContinuationMiddleware,
    skillReadPolicyMiddleware,
  ];

  return createDeepAgent({
    model,
    systemPrompt: buildSystemPrompt(opts.hasSandbox ?? false) + (opts.systemPromptExtra ?? ''),
    tools: [getWeatherTool, sendEmailTool],
    backend,
    skills: ['/skills/'],
    contextSchema,
    // 顺序即 recency：数组靠后 = 更内层 = systemMessage.concat 更晚 = 离模型更近。
    middleware,
    interruptOn: { send_email: true },
    checkpointer: opts.checkpointer as never,
    ...(opts.store ? { store: opts.store as never } : {}),
  });
}
