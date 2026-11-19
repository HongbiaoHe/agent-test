import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildChatModel } from './build-model';
import { listModels } from './list-models';
import type { ModelCapabilities, ProviderConnection } from './types';

/**
 * 两级测试：
 *  1. 测连接：请求一次模型列表接口，验证 Base URL 与 Key（不消耗 token）；
 *  2. 测模型：绑定一个假工具发一次最小请求，看模型会不会发起工具调用——desktop 的 agent 离不开工具，
 *     能聊天但不调工具的模型选上也跑不起来。
 */

const TEST_TIMEOUT_MS = 60_000;
const MAX_MESSAGE = 500;

export type ModelTestStatus = 'ok' | 'no_tools' | 'error';

export interface ModelTestResult {
  status: ModelTestStatus;
  /** 失败时服务端的原始错误（截断）；不支持工具时的说明 */
  message: string | null;
  testedAt: string;
  latencyMs: number;
  /** 带思考摘要请求失败、去掉后成功：调用方应把该模型的 reasoningSummary 置为 false */
  reasoningSummaryUnsupported?: true;
}

export interface ConnectionTestResult {
  ok: boolean;
  modelCount: number;
  message: string | null;
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, MAX_MESSAGE);
}

export async function testConnection(
  conn: ProviderConnection,
): Promise<ConnectionTestResult> {
  try {
    const models = await listModels(conn, AbortSignal.timeout(TEST_TIMEOUT_MS));
    return { ok: true, modelCount: models.length, message: null };
  } catch (e) {
    return { ok: false, modelCount: 0, message: errorText(e) };
  }
}

const pingTool = tool(({ value }: { value: string }) => value, {
  name: 'ping',
  description: 'Connectivity check. Call it with value "ok".',
  schema: z.object({ value: z.string().describe('Always "ok"') }),
});

export async function testModel(
  conn: ProviderConnection,
  modelId: string,
  caps: ModelCapabilities,
): Promise<ModelTestResult> {
  const result = await pingModel(conn, modelId, caps);
  // OpenAI 未验证的组织不能要思考摘要（400 … must be verified to generate reasoning summaries）：
  // 去掉摘要重测一次，通过就告诉调用方关掉它，免得每轮对话都 400
  if (
    result.status === 'error' &&
    conn.protocol === 'openai' &&
    caps.thinkingStyle === 'openai-effort' &&
    caps.reasoningSummary !== false &&
    /summar/i.test(result.message ?? '')
  ) {
    const retry = await pingModel(conn, modelId, {
      ...caps,
      reasoningSummary: false,
    });
    if (retry.status !== 'error')
      return { ...retry, reasoningSummaryUnsupported: true };
  }
  return result;
}

async function pingModel(
  conn: ProviderConnection,
  modelId: string,
  caps: ModelCapabilities,
): Promise<ModelTestResult> {
  const started = Date.now();
  const done = (
    status: ModelTestStatus,
    message: string | null,
  ): ModelTestResult => ({
    status,
    message,
    testedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
  });
  try {
    const model = buildChatModel(conn, modelId, caps, 'auto');
    if (!model.bindTools)
      return done('no_tools', '该模型的客户端不支持绑定工具');
    const res = await model
      .bindTools([pingTool])
      .invoke(
        [
          new HumanMessage(
            'Call the `ping` tool now with {"value": "ok"}. Do not answer with text.',
          ),
        ],
        { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
      );
    return (res.tool_calls?.length ?? 0) > 0
      ? done('ok', null)
      : done(
          'no_tools',
          '模型回了文字但没有发起工具调用，agent 可能无法使用工具',
        );
  } catch (e) {
    return done('error', errorText(e));
  }
}
