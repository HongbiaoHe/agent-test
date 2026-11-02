import { createHash } from 'node:crypto';

/**
 * MCP 工具在 agent 里的名字：`<serverSlug>__<toolName>`。
 * - 加前缀：不同 server 的同名工具（search / get_task）不会互相覆盖，也不会撞上内置工具
 *   （如 Spark 自己的 generate_image）；
 * - 只留 [a-zA-Z0-9_]、≤64 字符：Gemini / OpenAI 的函数名约束的交集。超长截断并补 hash，保证唯一。
 */
const MAX_TOOL_NAME = 64;
const SEP = '__';

function clean(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 由 server 名（或域名）推出前缀 slug：小写、≤20 字符，空了退回 mcp。 */
export function slugify(name: string): string {
  const s = clean(name.toLowerCase()).replace(/_+/g, '_').slice(0, 20);
  return s.replace(/_+$/, '') || 'mcp';
}

/** 在已占用的 slug 里找一个不冲突的：buzzvideo → buzzvideo_2 → buzzvideo_3 … */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 17)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function modelToolName(slug: string, toolName: string): string {
  const full = `${slug}${SEP}${clean(toolName) || 'tool'}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash('sha256').update(toolName).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}
