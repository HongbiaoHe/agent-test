import { z } from 'zod';
import { CANVAS_NODE_TYPES, type CanvasOpInput } from './canvas.types';

/**
 * 结构编辑 op 的 zod 校验：把请求里的 op（Record<string,unknown>）收窄成强类型 CanvasOpInput。
 * - canvasOpSchema：用户 REST 编辑（POST /canvas/:id/ops）；
 * - canvasAgentOpSchema：desktop 本机 agent 经 canvas-agent 接口提交的 op——与服务端 agent 工具构造的
 *   op 同形，新建生成节点时可带上已校验过的模型配置。
 * 服务端画布 agent 的工具在进程内直接构造 typed op，不经此。
 */
const nodeType = z.enum(CANVAS_NODE_TYPES as unknown as [string, ...string[]]);

/**
 * 生成节点的模型选择：值域由 aigc 目录决定（服务端在建生成时还会过一遍 resolveConfig），
 * 这里只校验形状——目录随时会变，客户端拿到的清单才是当时的权威。
 */
const mediaConfigFields = {
  mediaChannel: z.string().optional(),
  mediaModel: z.string().optional(),
  mediaParams: z.record(z.string(), z.string()).optional(),
};

const addNodeFields = {
  op: z.literal('add_node'),
  type: nodeType,
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string().optional(),
  prompt: z.string().optional(),
  assetPath: z.string().optional(),
  // 复制上传节点时副本挂同一份上传资产（见前端 duplicateFromCanvas）；agent 把附件摆上画布也走它
  mediaGenerationId: z.string().optional(),
};

/** 除 add_node 外，用户与 agent 共用的 op */
const sharedOps = [
  z.object({
    op: z.literal('update_node'),
    nodeId: z.string(),
    label: z.string().optional(),
    prompt: z.string().optional(),
    assetPath: z.string().optional(),
    mediaGenerationId: z.string().optional(),
    ...mediaConfigFields,
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
  z.object({
    op: z.literal('reorder_inputs'),
    nodeId: z.string(),
    sourceIds: z.array(z.string()),
  }),
] as const;

export const canvasOpSchema: z.ZodType<CanvasOpInput> = z.discriminatedUnion(
  'op',
  [z.object(addNodeFields), ...sharedOps],
) as z.ZodType<CanvasOpInput>;

export const canvasAgentOpSchema: z.ZodType<CanvasOpInput> =
  z.discriminatedUnion('op', [
    z.object({ ...addNodeFields, ...mediaConfigFields }),
    ...sharedOps,
  ]) as z.ZodType<CanvasOpInput>;
