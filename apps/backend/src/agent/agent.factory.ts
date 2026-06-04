import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createDeepAgent, StateBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { injectActivePlan, injectSkillReadPolicy } from './plan-injection';
import { getWeatherTool } from './tools/get-weather.tool';
import { sendEmailTool } from './tools/send-email.tool';

const SYSTEM_PROMPT = `你是一个动态加载skills的助手

## 斜杠命令（/command）
当用户**本轮**的请求以 \`/<技能名>\`（如 \`/tvc-director ...\`）开头时，这是显式指定要使用的技能：
按上面「Skills System」里对应技能的指示加载并遵循它的 SKILL.md，把 \`/\` 命令后面的文字当作该技能的输入；命令后无内容时，按该技能说明执行即可。

加载 SKILL.md **不等于**加载完毕：SKILL.md 只是技能的入口索引。读完它后，必须先判断**完成当前任务还需要哪些技能内部资源**，再用 \`read_file\` 按需把它们读进来，然后才动手：
- **reference 文档**：SKILL.md 里出现的 \`./references/*.md\`、\`references/*.md\` 等引用，尤其是被标注为「阶段前置 / 强制 / 必须先 read_file」的，必须在产出对应内容**之前**读取；
- **子技能（sub-skill）**：SKILL.md 用 markdown 链接（如 \`[xxx](./sub-skill.md)\`）路由到的子技能文件，命中该路由时才读取对应文件；
- **其它资产**：SKILL.md 指向的模板、词库、示例、图片等（如 \`./assets/*\`），按当前步骤实际需要再读。
原则是 progressive disclosure——**按需加载**：只读当前这一步真正用得到的资源，不要一次性把所有 reference 都读进来；但也**不要跳过**SKILL.md 明确要求前置读取的资源就直接产出。

注意：只对用户**当前这一轮**的请求这样做。历史对话里出现过、且其后已经有过助手回复的 \`/\` 命令，表示上一轮已经处理完毕，**不要再重新加载技能或重新执行**——除非用户本轮重新发起。`;

export interface BuildAgentOptions {
  /** RedisSaver 实例；配 interruptOn 审批时必须传。 */
  checkpointer?: unknown;
  /** 追加到系统提示末尾（如 /command 强制使用某技能的指令）。 */
  systemPromptExtra?: string;
  /** 本次回答模型（前端可切换）；缺省时回退 env GOOGLE_GENAI_MODEL / 代码默认。 */
  model?: string;
}

/** 运行时 context schema：worker 经 `context.activePlan` 传入「当前任务计划」文本。 */
const contextSchema = z.object({ activePlan: z.string().optional() });

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

/**
 * 装配主 agent：Gemini + 内置 + get_weather + 需审批的 send_email。
 * 启用 deepagents 原生 SkillsMiddleware：技能文件由 worker 每轮经 invoke 的 `files`
 * 注入 per-thread StateBackend 的 /skills/ 下；中间件把技能列进系统提示，agent 用
 * read_file 按需加载（progressive disclosure）。`files` 随 thread_id 隔离 → 多租户互不影响。
 */
export function buildAgent(opts: BuildAgentOptions = {}): any {
  const model = new ChatGoogleGenerativeAI({
    model: opts.model ?? process.env.GOOGLE_GENAI_MODEL ?? 'gemini-3.5-flash',
    apiKey: process.env.GOOGLE_API_KEY,
  });

  return createDeepAgent({
    model,
    systemPrompt: SYSTEM_PROMPT + (opts.systemPromptExtra ?? ''),
    tools: [getWeatherTool, sendEmailTool],
    backend: new StateBackend(),
    skills: ['/skills/'],
    contextSchema,
    // 顺序即 recency：数组靠后 = 更内层 = systemMessage.concat 更晚 = 离模型更近。
    // 引用必读规则放最后，确保它是模型读到的最末一条硬规则。
    middleware: [planContinuationMiddleware, skillReadPolicyMiddleware],
    interruptOn: { send_email: true },
    checkpointer: opts.checkpointer as never,
  });
}
