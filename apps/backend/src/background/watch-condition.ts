import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * watch 任务的判定：从一次 MCP 工具结果里按点路径取值，与目标取值表比对。
 *
 * 取值来源优先 structuredContent（MCP 推荐的结构化结果）；没有就把第一段 text 当 JSON 解析
 * （多数 server 的文本结果就是 JSON 串）。路径支持数组下标：`tasks.0.status`。
 * 取不到值视为「还没到」，继续轮询——而不是失败：任务刚建时字段可能尚未出现。
 */
export type WatchOutcome = 'done' | 'failed' | 'pending';

export function resultPayload(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const first = result.content?.find((b) => b.type === 'text');
  if (!first || first.type !== 'text') return undefined;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return first.text;
  }
}

export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.').filter(Boolean)) {
    if (Array.isArray(cur)) {
      const i = Number(key);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (cur && typeof cur === 'object') {
      // 解析出的 JSON 对象：按任意键读取，读不到即 undefined
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 标量统一成字符串比较（status 可能是 "completed" / true / 2）；对象、数组不参与匹配。 */
function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function evaluateWatch(
  result: CallToolResult,
  untilPath: string,
  doneValues: readonly string[],
  failValues: readonly string[],
): { outcome: WatchOutcome; value?: string } {
  const value = scalar(readPath(resultPayload(result), untilPath));
  if (value === undefined) return { outcome: 'pending' };
  if (failValues.includes(value)) return { outcome: 'failed', value };
  if (doneValues.includes(value)) return { outcome: 'done', value };
  return { outcome: 'pending', value };
}
