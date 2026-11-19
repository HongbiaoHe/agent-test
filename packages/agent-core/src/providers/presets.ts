import type { ProviderProtocol, ThinkingStyle } from './types';

/**
 * 连接预设：帮用户填好协议、Base URL 和思考参数写法，建好后 Base URL 仍可改（换海外节点 / 公司代理）。
 * Base URL 与思考参数按各家官方文档核对（2026-11-20）：
 *  - DeepSeek thinking_mode：`thinking: { type: enabled | disabled }`（api-docs.deepseek.com/guides/thinking_mode）
 *  - 通义 DashScope 兼容模式：`enable_thinking`；北京地域 dashscope.aliyuncs.com/compatible-mode/v1
 *    （国际站 dashscope-intl.aliyuncs.com，可改 Base URL）
 *  - 智谱 BigModel：open.bigmodel.cn/api/paas/v4，`thinking.type`（国际站 api.z.ai/api/paas/v4）
 *  - 硅基流动：api.siliconflow.cn/v1，`enable_thinking`（国际站 api.siliconflow.com/v1）
 *  - OpenRouter：`reasoning: { effort }`
 *  - Moonshot：api.moonshot.cn/v1（国际站 api.moonshot.ai/v1）
 */
export interface ProviderPreset {
  id: string;
  protocol: ProviderProtocol;
  /** 新建连接时的默认显示名 */
  name: string;
  baseUrl: string;
  /** 本地服务不需要 Key */
  keyRequired: boolean;
  /** 该服务的思考参数写法（新拉到的模型按它给默认能力） */
  thinkingStyle: ThinkingStyle;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    protocol: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    thinkingStyle: 'openai-effort',
  },
  {
    id: 'anthropic',
    protocol: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyRequired: true,
    thinkingStyle: 'anthropic',
  },
  {
    id: 'gemini',
    protocol: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyRequired: true,
    thinkingStyle: 'gemini',
  },
  {
    id: 'deepseek',
    protocol: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyRequired: true,
    thinkingStyle: 'thinking-type',
  },
  {
    id: 'dashscope',
    protocol: 'openai-compatible',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyRequired: true,
    thinkingStyle: 'enable-thinking',
  },
  {
    id: 'zhipu',
    protocol: 'openai-compatible',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyRequired: true,
    thinkingStyle: 'thinking-type',
  },
  {
    id: 'moonshot',
    protocol: 'openai-compatible',
    name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyRequired: true,
    thinkingStyle: 'none',
  },
  {
    id: 'siliconflow',
    protocol: 'openai-compatible',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyRequired: true,
    thinkingStyle: 'enable-thinking',
  },
  {
    id: 'openrouter',
    protocol: 'openai-compatible',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    thinkingStyle: 'openrouter',
  },
  {
    id: 'groq',
    protocol: 'openai-compatible',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    thinkingStyle: 'none',
  },
  {
    id: 'xai',
    protocol: 'openai-compatible',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyRequired: true,
    thinkingStyle: 'none',
  },
  {
    id: 'ollama',
    protocol: 'openai-compatible',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    thinkingStyle: 'none',
  },
  {
    id: 'lmstudio',
    protocol: 'openai-compatible',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    keyRequired: false,
    thinkingStyle: 'none',
  },
  {
    id: 'custom',
    protocol: 'openai-compatible',
    name: '自定义',
    baseUrl: '',
    keyRequired: false,
    thinkingStyle: 'none',
  },
];

export function findPreset(
  id: string | null | undefined,
): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}
