import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeToolSchema } from './mcp-schema';
import type { McpToolSnapshot, ToolVisibility } from './mcp-types';

/** 单个工具结果喂给模型的文本上限：超出截断并注明，防一次结果吃光上下文。 */
export const MAX_MODEL_TEXT = 20_000;

function truncate(text: string, max = MAX_MODEL_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** base64 长度 → 大致字节数的可读形式（占位文本里给模型一个量级）。 */
function approxSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
}

/**
 * CallToolResult → 给模型的文本（设计 Q15：第一版统一转文本）。
 * - text 原样；image / audio 换占位（不把 base64 塞进上下文）；
 * - resource_link / 内嵌 resource 只给 uri、name、mimeType（内嵌文本正文同样截断）；
 * - content 为空但有 structuredContent：序列化它兜底（规范建议 server 总给文本回退，这里防不给的）。
 * structuredContent / _meta 本身只给 UI，不进模型上下文（设计 Q9）。
 */
export function resultToModelText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'audio':
        parts.push(
          `[${block.type}: ${block.mimeType}, ${approxSize(block.data)}]`,
        );
        break;
      case 'resource_link':
        parts.push(
          `[resource: ${block.uri}${block.name ? ` name=${block.name}` : ''}${block.mimeType ? ` mimeType=${block.mimeType}` : ''}]`,
        );
        break;
      case 'resource': {
        const r = block.resource;
        const head = `[resource: ${r.uri}${r.mimeType ? ` mimeType=${r.mimeType}` : ''}]`;
        parts.push('text' in r ? `${head}\n${r.text}` : head);
        break;
      }
    }
  }
  let text = parts.join('\n\n');
  if (!text && result.structuredContent) {
    text = JSON.stringify(result.structuredContent);
  }
  return truncate(text || '(empty result)');
}

/**
 * 读工具的 MCP App UI 资源。新写法 `_meta.ui.resourceUri`，旧写法 `_meta["ui/resourceUri"]`
 * 规范已标废弃，但 BuzzVideo 等 server 仍两种并存（实测），两种都认。
 */
export function toolUiResourceUri(
  tool: Pick<Tool, '_meta'>,
): string | undefined {
  const meta = tool._meta;
  const ui = meta?.ui;
  const uri =
    (ui && typeof ui === 'object' && 'resourceUri' in ui
      ? ui.resourceUri
      : undefined) ?? meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

function toolVisibility(tool: Pick<Tool, '_meta'>): ToolVisibility[] {
  const ui = tool._meta?.ui;
  const raw =
    ui && typeof ui === 'object' && 'visibility' in ui
      ? ui.visibility
      : undefined;
  if (!Array.isArray(raw)) return ['model', 'app'];
  const vis = raw.filter(
    (v): v is ToolVisibility => v === 'model' || v === 'app',
  );
  return vis.length > 0 ? vis : ['model', 'app'];
}

/** tools/list 的一项 → 落库快照（schema 在这里清洗一次，agent 每轮直接用）。 */
export function toToolSnapshot(tool: Tool): McpToolSnapshot {
  const sanitized = sanitizeToolSchema(tool.inputSchema);
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    modelSchema: sanitized.schema ?? null,
    incompatibleReason: sanitized.error,
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true,
    uiResourceUri: toolUiResourceUri(tool),
    visibility: toolVisibility(tool),
  };
}
