import { z } from 'zod';
import { CANVAS_NODE_TYPES, type CanvasOpInput } from './canvas.types';

/**
 * 用户 REST 结构编辑 op 的 zod 校验：把 ApplyOpDto.op（Record<string,unknown>）收窄成
 * 强类型 CanvasOpInput（agent 工具直接构造 typed op，无需经此）。
 */
const nodeType = z.enum(CANVAS_NODE_TYPES as unknown as [string, ...string[]]);

export const canvasOpSchema: z.ZodType<CanvasOpInput> = z.discriminatedUnion(
  'op',
  [
    z.object({
      op: z.literal('add_node'),
      type: nodeType,
      x: z.number().optional(),
      y: z.number().optional(),
      label: z.string().optional(),
      text: z.string().optional(),
      prompt: z.string().optional(),
      assetPath: z.string().optional(),
    }),
    z.object({
      op: z.literal('update_node'),
      nodeId: z.string(),
      label: z.string().optional(),
      text: z.string().optional(),
      prompt: z.string().optional(),
      assetPath: z.string().optional(),
      mediaGenerationId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    z.object({ op: z.literal('remove_node'), nodeId: z.string() }),
    z.object({
      op: z.literal('add_edge'),
      source: z.string(),
      target: z.string(),
    }),
    z.object({ op: z.literal('remove_edge'), edgeId: z.string() }),
    z.object({ op: z.literal('clear') }),
  ],
) as z.ZodType<CanvasOpInput>;
