import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createDeepAgent, StateBackend } from 'deepagents';
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
}

/**
 * 装配主 agent：Gemini + 内置 + get_weather + 需审批的 send_email。
 * 启用 deepagents 原生 SkillsMiddleware：技能文件由 worker 每轮经 invoke 的 `files`
 * 注入 per-thread StateBackend 的 /skills/ 下；中间件把技能列进系统提示，agent 用
 * read_file 按需加载（progressive disclosure）。`files` 随 thread_id 隔离 → 多租户互不影响。
 */
export function buildAgent(opts: BuildAgentOptions = {}): any {
  const model = new ChatGoogleGenerativeAI({
    model: process.env.GOOGLE_GENAI_MODEL ?? 'gemini-2.0-flash',
    apiKey: process.env.GOOGLE_API_KEY,
  });

  return createDeepAgent({
    model,
    systemPrompt: SYSTEM_PROMPT + (opts.systemPromptExtra ?? ''),
    tools: [getWeatherTool, sendEmailTool],
    backend: new StateBackend(),
    skills: ['/skills/'],
    interruptOn: { send_email: true },
    checkpointer: opts.checkpointer as never,
  });
}
