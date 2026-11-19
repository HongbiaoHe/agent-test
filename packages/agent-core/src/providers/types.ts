import type { ThinkingLevel } from '../agent/thinking-level';

/**
 * 用户自己配置的 LLM 连接（desktop「API 连接」）：按**接口协议**而不是按厂商接入。
 * 四种协议覆盖绝大多数服务：OpenAI 官方、OpenAI 兼容的第三方（DeepSeek / 通义 / OpenRouter / Ollama…）、
 * Anthropic Messages、Google Gemini（AI Studio）。
 */
export const PROVIDER_PROTOCOLS = [
  'openai',
  'openai-compatible',
  'anthropic',
  'gemini',
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/**
 * 「思考」参数的写法：四种协议各不相同，OpenAI 兼容的第三方之间也不同。
 * - none：不支持 / 不暴露思考档位
 * - openai-effort：OpenAI 推理模型的 `reasoning.effort`（低 / 中 / 高）
 * - thinking-type：`thinking: { type: enabled | disabled }`（DeepSeek、智谱）
 * - enable-thinking：`enable_thinking: true | false`（通义、硅基流动）
 * - openrouter：`reasoning: { effort }`（OpenRouter 统一写法）
 * - anthropic：`thinking: { type: 'enabled', budget_tokens }`（按预算分档）
 * - gemini：`thinkingConfig`（档位 + 部分型号可关闭）
 */
export const THINKING_STYLES = [
  'none',
  'openai-effort',
  'thinking-type',
  'enable-thinking',
  'openrouter',
  'anthropic',
  'gemini',
] as const;
export type ThinkingStyle = (typeof THINKING_STYLES)[number];

/** 一个模型的能力设置（按协议给默认值，用户可逐个改） */
export interface ModelCapabilities {
  thinkingStyle: ThinkingStyle;
  /** 界面上可选的思考档位（含 auto = 不传参数，跟随模型默认） */
  thinkingLevels: ThinkingLevel[];
  /** 上下文窗口（token）；未知为 null，历史压缩按固定阈值 */
  contextWindow: number | null;
  /**
   * OpenAI 推理模型（openai-effort）是否请求思考摘要（Responses API `reasoning.summary`）。
   * 缺省 = 请求；false = 不请求——组织未通过 OpenAI 验证时带上它整轮 400，测模型时遇到会自动关掉。
   */
  reasoningSummary?: boolean;
}

/** 构建模型 / 拉列表 / 测试用的连接参数（Key 已解密，只在内存里） */
export interface ProviderConnection {
  protocol: ProviderProtocol;
  baseUrl: string;
  /** 本地服务（Ollama / LM Studio）可以没有 */
  apiKey: string | null;
}

/** 「列出模型」接口拿到的一个模型 */
export interface ListedModel {
  id: string;
  displayName: string | null;
  /** 接口给了就带上（Gemini inputTokenLimit、OpenRouter context_length） */
  contextWindow: number | null;
  /** 接口明确说支不支持思考（Gemini 的 thinking 字段）；不知道为 null */
  thinking: boolean | null;
}
