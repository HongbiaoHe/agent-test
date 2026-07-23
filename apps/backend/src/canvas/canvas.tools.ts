import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MediaService } from '../media/media.service';
import { CanvasService } from './canvas.service';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from './canvas.types';

/** 工具运行上下文：worker 闭包注入当前画布会话与可信 userId（不经模型，无注入风险）。 */
export interface CanvasToolContext {
  sessionId: string;
  userId: string;
}

const nodeTypeEnum = z.enum(
  CANVAS_NODE_TYPES as unknown as [CanvasNodeType, ...CanvasNodeType[]],
);

/**
 * 构造画布操作工具，闭包带上会话上下文。所有结构变更经 CanvasService.applyOp（唯一写入口，
 * 事务 + op 日志 + 广播 canvas_patch）。generate_media_node 复用 MediaService（异步生成）。
 */
export function createCanvasTools(
  canvas: CanvasService,
  media: MediaService,
  ctx: CanvasToolContext,
) {
  // 注：不再提供 get_canvas 工具——画布状态（节点/连线/安全区）已由 worker 每轮实时注入系统提示
  // （见 CanvasService.agentCanvasContext + canvasLiveStateMiddleware），agent 直接读提示即可。

  const addNode = tool(
    async ({ type, label, text, prompt, x, y }) => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'add_node',
        type,
        label,
        text,
        prompt,
        x,
        y,
      });
      const node = 'node' in r.patch ? r.patch.node : null;
      return JSON.stringify({ nodeId: node?.id, revision: r.revision });
    },
    {
      name: 'add_node',
      description:
        '在画布上新建一个节点。type：text(文本) | image_upload(上传图片占位) | image_gen(生图) | video_gen(生视频)。生成类节点用 prompt 写提示词；text 节点用 text 写正文。x/y 为画布坐标（按工作流从左到右布局，纵向错开避免重叠）。返回 nodeId。',
      schema: z.object({
        type: nodeTypeEnum,
        label: z.string().optional().describe('节点标题（可选）'),
        text: z.string().optional().describe('text 节点正文'),
        prompt: z
          .string()
          .optional()
          .describe('image_gen/video_gen 的生成提示词'),
        x: z.number().optional(),
        y: z.number().optional(),
      }),
    },
  );

  const updateNode = tool(
    async ({ nodeId, label, text, prompt, x, y }) => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'update_node',
        nodeId,
        label,
        text,
        prompt,
        x,
        y,
      });
      return JSON.stringify({ ok: true, revision: r.revision });
    },
    {
      name: 'update_node',
      description:
        '修改已存在节点的 label / text / prompt，或移动节点位置 x/y（放入安全区避免重叠）。',
      schema: z.object({
        nodeId: z.string(),
        label: z.string().optional(),
        text: z.string().optional(),
        prompt: z.string().optional(),
        x: z.number().optional().describe('新的画布 x 坐标'),
        y: z.number().optional().describe('新的画布 y 坐标'),
      }),
    },
  );

  const connectNodes = tool(
    async ({ sourceId, targetId }) => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'add_edge',
        source: sourceId,
        target: targetId,
      });
      const edge = 'edge' in r.patch ? r.patch.edge : null;
      return JSON.stringify({ edgeId: edge?.id, revision: r.revision });
    },
    {
      name: 'connect_nodes',
      description:
        '用有向连线连接两个节点（sourceId → targetId，表示 source 是 target 的上游输入）。例如把 image_gen 连到 video_gen 表示用生成的图作视频首帧。',
      schema: z.object({ sourceId: z.string(), targetId: z.string() }),
    },
  );

  const deleteNode = tool(
    async ({ nodeId }) => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'remove_node',
        nodeId,
      });
      return JSON.stringify({ ok: true, revision: r.revision });
    },
    {
      name: 'delete_node',
      description: '删除一个节点（会级联删除它的相关连线）。',
      schema: z.object({ nodeId: z.string() }),
    },
  );

  const generateMediaNode = tool(
    async ({ nodeId }) => {
      const snap = await canvas.agentSnapshot(ctx.sessionId);
      const node = snap.nodes.find((n) => n.id === nodeId);
      if (!node) {
        return JSON.stringify({ error: '节点不存在', nodeId });
      }
      if (node.type !== 'image_gen' && node.type !== 'video_gen') {
        return JSON.stringify({
          error: '只有 image_gen / video_gen 节点可触发生成',
          type: node.type,
        });
      }
      if (!node.prompt?.trim()) {
        return JSON.stringify({
          error: '该节点尚无 prompt，请先 update_node 写好提示词',
        });
      }

      // 沿入边收集上游已完成的图片版本作参考图/首帧
      const upstreamIds = snap.edges
        .filter((e) => e.target === nodeId)
        .map((e) => e.source);
      const referenceVersionIds = snap.nodes
        .filter(
          (n) =>
            upstreamIds.includes(n.id) &&
            (n.type === 'image_gen' || n.type === 'image_upload') &&
            n.mediaStatus === 'done' &&
            !!n.mediaVersionId,
        )
        .map((n) => n.mediaVersionId as string);

      const type = node.type === 'video_gen' ? 'video' : 'image';
      const { generationId } = await media.createGeneration(
        ctx.sessionId,
        ctx.userId,
        type,
        node.prompt,
        referenceVersionIds.length ? referenceVersionIds : undefined,
      );
      // 回填 generationId：快照/前端据此显示生成状态与资产
      await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'update_node',
        nodeId,
        mediaGenerationId: generationId,
      });
      return JSON.stringify({
        generationId,
        status: 'queued',
        references: referenceVersionIds.length,
      });
    },
    {
      name: 'generate_media_node',
      description:
        '触发某个 image_gen / video_gen 节点的实际生成（异步）。会自动沿该节点的入边收集上游已生成完成的图片作为参考图（视频取首帧）。触发后立即返回 queued，卡片状态自动更新，不要重复触发同一节点。',
      schema: z.object({ nodeId: z.string() }),
    },
  );

  const clearCanvas = tool(
    async () => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', { op: 'clear' });
      return JSON.stringify({ ok: true, cleared: true, revision: r.revision });
    },
    {
      name: 'clear_canvas',
      description:
        '清空整块画布：一次性删除全部节点与连线。用于"删除所有节点/推倒重来"，比逐个 delete_node 可靠高效。此操作有破坏性，会先请用户确认再执行。',
      schema: z.object({}),
    },
  );

  const askUser = tool(
    ({ question }: { question: string }) => {
      // 实际中断由 interruptOn 拦截；这里的返回值仅在恢复时被用户答案替换（respond 决策）。
      return question;
    },
    {
      name: 'ask_user',
      description:
        '向用户提问并等待回答（用于关键澄清：风格方向、数量、是否继续等）。调用会暂停执行直到用户回答。避免对细枝末节频繁提问。',
      schema: z.object({
        question: z.string().describe('要问用户的问题'),
        options: z
          .array(z.string())
          .optional()
          .describe('可选项（供用户快速选择，可空）'),
      }),
    },
  );

  return [
    addNode,
    updateNode,
    connectNodes,
    deleteNode,
    clearCanvas,
    generateMediaNode,
    askUser,
  ];
}
