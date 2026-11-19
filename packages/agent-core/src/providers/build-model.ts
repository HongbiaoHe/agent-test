import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { ThinkingLevel } from '../agent/thinking-level';
import { ANTHROPIC_DEFAULT_MAX_TOKENS, thinkingParams } from './capabilities';
import type { ModelCapabilities, ProviderConnection } from './types';

/**
 * 按连接构建 LangChain 模型实例（不经 initChatModel / 环境变量：Key 与 Base URL 都来自用户的连接配置）。
 *  - openai：ChatOpenAI，走 Responses API（新推理模型在 Chat Completions 上不能同时用工具与推理）
 *  - openai-compatible：ChatDeepSeek 换 Base URL——它继承 ChatOpenAI，额外解析第三方返回的
 *    reasoning_content（ChatOpenAI 只认 OpenAI 自己的推理字段，DeepSeek / 通义 / 智谱 / vLLM 的思考会丢）
 *  - anthropic：ChatAnthropic（Messages API）
 *  - gemini：ChatGoogleGenerativeAI（AI Studio）
 */

/** 本地服务不要 Key，但 OpenAI 系客户端构造时必须有值（ChatDeepSeek 没有 Key 直接抛错） */
const NO_KEY = 'not-needed';

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function buildChatModel(
  conn: ProviderConnection,
  modelId: string,
  caps: ModelCapabilities,
  level?: ThinkingLevel | null,
): BaseChatModel {
  const baseURL = normalizeBaseUrl(conn.baseUrl);
  const apiKey = conn.apiKey?.trim() || NO_KEY;
  const thinking = thinkingParams(caps, modelId, level);
  switch (conn.protocol) {
    case 'openai': {
      // 标准 OpenAI 走 Responses API：GPT-5.x 之后的推理模型在 /v1/chat/completions 上不允许「函数工具 +
      // 推理」同时出现（400 Function tools with reasoning_effort are not supported … use /v1/responses），
      // 而 agent 每轮都带工具。只能走 Chat Completions 的网关改用「OpenAI 兼容」协议建连接。
      const reasoning = {
        ...(thinking.kind === 'openai' && { effort: thinking.effort }),
        // 推理过程本身不返回，只能要摘要（显示在思考面板里）；档位为 auto 时也要
        ...(caps.thinkingStyle === 'openai-effort' &&
          caps.reasoningSummary !== false && { summary: 'auto' as const }),
      };
      return new ChatOpenAI({
        model: modelId,
        apiKey,
        configuration: { baseURL },
        useResponsesApi: true,
        ...(Object.keys(reasoning).length > 0 && { reasoning }),
      });
    }
    case 'openai-compatible':
      return new ChatDeepSeek({
        model: modelId,
        apiKey,
        configuration: { baseURL },
        ...(thinking.kind === 'model-kwargs' && {
          modelKwargs: thinking.modelKwargs,
        }),
      });
    case 'anthropic':
      return new ChatAnthropic({
        model: modelId,
        apiKey,
        anthropicApiUrl: baseURL,
        ...(thinking.kind === 'anthropic'
          ? {
              maxTokens: thinking.maxTokens,
              thinking: {
                type: 'enabled',
                budget_tokens: thinking.budgetTokens,
              },
            }
          : { maxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS }),
      });
    case 'gemini':
      return new ChatGoogleGenerativeAI({
        model: modelId,
        apiKey,
        baseUrl: baseURL,
        ...(thinking.kind === 'gemini' ? thinking.params : {}),
      });
  }
}

/**
 * 历史里的 provider 原生内容块（思考块、functionCall 块）能否原样回传：只有 Gemini 能，且它的思考签名
 * 必须原样回传；其它协议都要净化（见 agent/portable-content.ts）。
 */
export function keepsNativeBlocksFor(
  conn: Pick<ProviderConnection, 'protocol'>,
): boolean {
  return conn.protocol === 'gemini';
}
