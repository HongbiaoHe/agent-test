import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createDeepAgent, StateBackend } from 'deepagents';
import { getWeatherTool } from './tools/get-weather.tool';
import { sendEmailTool } from './tools/send-email.tool';

const SYSTEM_PROMPT = `你是一个任务自动化助手。
收到目标后，先用 write_todos 工具拆解出步骤计划，再逐步执行。
查天气用 get_weather；需要发邮件时**直接调用 send_email 工具**（系统会自动拦截并请用户审批，你无需也不要用文字去询问用户是否发送，直接发起工具调用即可）。
完成后给出简洁的中文总结。`;

export interface BuildAgentOptions {
  /** RedisSaver 实例；配 interruptOn 审批时必须传。 */
  checkpointer?: unknown;
}

/** 装配主 agent：Gemini + 内置 + get_weather + 需审批的 send_email。 */
export function buildAgent(opts: BuildAgentOptions = {}): any {
  const model = new ChatGoogleGenerativeAI({
    model: process.env.GOOGLE_GENAI_MODEL ?? 'gemini-2.0-flash',
    apiKey: process.env.GOOGLE_API_KEY,
  });

  return createDeepAgent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [getWeatherTool, sendEmailTool],
    backend: new StateBackend(),
    interruptOn: { send_email: true },
    checkpointer: opts.checkpointer as never,
  });
}
