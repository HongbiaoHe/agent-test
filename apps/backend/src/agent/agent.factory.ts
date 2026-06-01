import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createDeepAgent, StateBackend } from 'deepagents';
import { getWeatherTool } from './tools/get-weather.tool';
import { sendEmailTool } from './tools/send-email.tool';

const SYSTEM_PROMPT = `你是一个任务自动化助手。
收到目标后，先用 write_todos 工具拆解出步骤计划，再逐步执行。
查天气用 get_weather；需要发邮件时**直接调用 send_email 工具**（系统会自动拦截并请用户审批，你无需也不要用文字去询问用户是否发送，直接发起工具调用即可）。
完成后给出简洁的中文总结。

## 斜杠命令（/command）
当用户**本轮**的请求以 \`/<技能名>\`（如 \`/tvc-director ...\`）开头时，这是显式指定要使用的技能：
按上面「Skills System」里对应技能的指示加载并遵循它的 SKILL.md，把 \`/\` 命令后面的文字当作该技能的输入；命令后无内容时，按该技能说明执行即可。
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
