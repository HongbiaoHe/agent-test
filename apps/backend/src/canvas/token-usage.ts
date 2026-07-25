import { isAIMessage, isBaseMessage } from '@langchain/core/messages';
import type {
  CanvasTokenCall,
  CanvasTokenModelUsage,
  CanvasTokenTotals,
} from './canvas.types';

/**
 * 画布 agent 的 token 会计纯逻辑：从流事件抽取每次模型调用的用量（区分缓存命中）+ 合计/分组。
 * 独立于 processor 与 service：两边都要用，且不能碰 deepagents（ESM，jest 跑不动）。
 */

/** 一次模型调用的 token 用量（cacheRead / cacheCreation ⊆ input）。 */
export interface CallUsage {
  model: string;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * 从 updates 模式的节点更新里抽取带 usage_metadata 的 AIMessage token 用量。
 * 按 message id 去重（同一 AIMessage 可能在多个节点回显）；一次更新里可能有**多条**新消息
 * （子 agent + 主 agent 同批回显），全部返回，不能只取第一条。抽不到返回空数组（不阻断运行）。
 *
 * 缓存明细取 langchain 标准字段 usage_metadata.input_token_details：
 * google-genai 映射 cachedContentTokenCount → cache_read；openai/deepseek 映射
 * prompt_tokens_details.cached_tokens → cache_read。两者的 input_tokens 都**已含**缓存部分，
 * 所以命中率 = cacheRead / input。
 */
export function extractUsages(
  data: unknown,
  seen: Set<string>,
  fallbackModel: string,
): CallUsage[] {
  const out: CallUsage[] = [];
  if (!data || typeof data !== 'object') return out;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const msgs = (value as { messages?: unknown[] }).messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!isBaseMessage(m) || !isAIMessage(m)) continue;
      const u = m.usage_metadata;
      if (!u) continue;
      const id = m.id ?? '';
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const total = u.total_tokens ?? input + output;
      if (!input && !output && !total) continue;
      out.push({
        model: responseModelName(m.response_metadata) ?? fallbackModel,
        input,
        output,
        total,
        cacheRead: u.input_token_details?.cache_read ?? 0,
        cacheCreation: u.input_token_details?.cache_creation ?? 0,
      });
    }
  }
  return out;
}

/**
 * 取响应里的真实模型名。openai/deepseek 回 response_metadata.model_name；
 * google-genai 只回 model_provider（无模型名）→ null，由调用方回落到本次运行请求的模型。
 */
function responseModelName(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const name = (meta as { model_name?: unknown }).model_name;
  return typeof name === 'string' && name ? name : null;
}

/** 合计一组调用的 token（calls = 调用次数）。 */
export function sumCalls(calls: CanvasTokenCall[]): CanvasTokenTotals {
  return calls.reduce<CanvasTokenTotals>(
    (acc, c) => ({
      calls: acc.calls + 1,
      input: acc.input + c.input,
      output: acc.output + c.output,
      total: acc.total + c.total,
      cacheRead: acc.cacheRead + c.cacheRead,
      cacheCreation: acc.cacheCreation + c.cacheCreation,
    }),
    { calls: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

/** 按模型分组合计，按总量倒序（吃 token 最多的模型在前）。 */
export function groupByModel(
  calls: CanvasTokenCall[],
): CanvasTokenModelUsage[] {
  const byModel = new Map<string, CanvasTokenCall[]>();
  for (const c of calls) {
    const list = byModel.get(c.model);
    if (list) list.push(c);
    else byModel.set(c.model, [c]);
  }
  return [...byModel]
    .map(([model, list]) => ({ model, ...sumCalls(list) }))
    .sort((a, b) => b.total - a.total);
}
