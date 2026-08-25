import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MediaService } from '../media/media.service';
import { CanvasService } from './canvas.service';
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
  shortNodeId,
} from './canvas.types';

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
  // 注：不再提供 get_canvas 工具——画布状态（节点/连线/安全区）已由 worker 自动注入对话
  // （见 CanvasService.agentCanvasContext + canvasLiveStateMiddleware），agent 直接读消息即可。

  /**
   * 解析模型给的节点 id。注入的画布状态里用的是短 id（完整 cuid 后 6 位，省 token），
   * 而 add_node 的返回值是完整 id —— 模型两种都可能回传，统一在这里反解成完整 id。
   * 解析不到（不存在 / 后缀有歧义）返回 null，各工具据此回一条明确错误给模型。
   */
  const resolveId = (id: string) => canvas.resolveNodeId(ctx.sessionId, id);

  const addNode = tool(
    async ({ type, label, text, x, y }) => {
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'add_node',
        type,
        label,
        text,
        x,
        y,
      });
      const node = 'node' in r.patch ? r.patch.node : null;
      // 回短 id：与注入的画布状态同一套写法，模型不必在两种 id 之间切换
      return JSON.stringify({
        nodeId: node ? shortNodeId(node.id) : undefined,
        revision: r.revision,
      });
    },
    {
      name: 'add_node',
      description:
        '在画布上新建一个节点。type：text(文本) | image_upload(上传图片占位) | image_gen(生图) | video_gen(生视频)。提示词写在 text 节点的 text 里，再连到生成节点——生成节点自身不接受提示词参数。x/y 为画布坐标（按工作流从左到右布局，纵向错开避免重叠）。返回 nodeId。',
      schema: z.object({
        type: nodeTypeEnum,
        label: z.string().optional().describe('节点标题（可选）'),
        text: z.string().optional().describe('text 节点正文（即提示词）'),
        x: z.number().optional(),
        y: z.number().optional(),
      }),
    },
  );

  const updateNode = tool(
    async ({ nodeId, label, text, x, y }) => {
      const full = await resolveId(nodeId);
      if (!full) return JSON.stringify({ error: '节点不存在', nodeId });
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'update_node',
        nodeId: full,
        label,
        text,
        x,
        y,
      });
      return JSON.stringify({ ok: true, revision: r.revision });
    },
    {
      name: 'update_node',
      description:
        '修改已存在节点的 label / text（text 即 text 节点的正文/提示词），或移动节点位置 x/y（放入安全区避免重叠）。生成节点没有可改的提示词字段——要换提示词就改它上游 text 节点的 text。',
      schema: z.object({
        nodeId: z.string(),
        label: z.string().optional(),
        text: z.string().optional(),
        x: z.number().optional().describe('新的画布 x 坐标'),
        y: z.number().optional().describe('新的画布 y 坐标'),
      }),
    },
  );

  const connectNodes = tool(
    async ({ sourceId, targetId }) => {
      const [source, target] = await Promise.all([
        resolveId(sourceId),
        resolveId(targetId),
      ]);
      if (!source || !target) {
        return JSON.stringify({
          error: '节点不存在',
          ...(source ? {} : { sourceId }),
          ...(target ? {} : { targetId }),
        });
      }
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'add_edge',
        source,
        target,
      });
      const edge = 'edge' in r.patch ? r.patch.edge : null;
      return JSON.stringify({ edgeId: edge?.id, revision: r.revision });
    },
    {
      name: 'connect_nodes',
      description:
        '用有向连线连接两个节点（sourceId → targetId，表示 source 是 target 的上游输入）。生成节点的提示词与参考图全靠这些入边提供：text 节点连过去就是提示词，image_gen 连过去就是参考图（video_gen 取第一张当首帧）。类型契约：text 输出 text；image_upload 输出 image；image_gen 接受 text/image 输出 image；video_gen 接受 text/image 输出 video（暂不支持 video 输入）。text 与 image_upload 没有输入端口，任何指向它们的连线都会被拒绝。',
      schema: z.object({ sourceId: z.string(), targetId: z.string() }),
    },
  );

  const deleteNode = tool(
    async ({ nodeId }) => {
      const full = await resolveId(nodeId);
      if (!full) return JSON.stringify({ error: '节点不存在', nodeId });
      const r = await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'remove_node',
        nodeId: full,
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
      const full = await resolveId(nodeId);
      const snap = await canvas.agentSnapshot(ctx.sessionId);
      const node = full ? snap.nodes.find((n) => n.id === full) : undefined;
      if (!node) {
        return JSON.stringify({ error: '节点不存在', nodeId });
      }
      if (node.type !== 'image_gen' && node.type !== 'video_gen') {
        return JSON.stringify({
          error: '只有 image_gen / video_gen 节点可触发生成',
          type: node.type,
        });
      }
      // 素材全部来自入边：生成节点自身不带提示词（契约见 canvas.types 的 CANVAS_NODE_IO）
      const upstreamIds = snap.edges
        .filter((e) => e.target === node.id)
        .map((e) => e.source);
      const upstream = snap.nodes.filter((n) => upstreamIds.includes(n.id));

      // text 输出 → 拼成本次生成的提示词（多个上游文本按边顺序编号拼接）
      const promptParts = upstream.flatMap((n) =>
        n.outputs.filter((o) => o.type === 'text').map((o) => o.content),
      );
      if (promptParts.length === 0) {
        return JSON.stringify({
          error:
            '该节点没有可用的提示词：生成节点不自带 prompt，请先 add_node 建一个 text 节点写好提示词，再 connect_nodes 连到它',
        });
      }
      // image 输出 → 参考图（视频取第一张作首帧）。只收 image_gen：image_upload 的 content
      // 是 assetPath 不是 versionId（MVP 模拟上传），传给 media 会被 validateReferences 拒。
      const referenceVersionIds = upstream
        .filter((n) => n.type === 'image_gen')
        .flatMap((n) =>
          n.outputs.filter((o) => o.type === 'image').map((o) => o.content),
        );
      const skippedUploads = upstream.filter(
        (n) => n.type === 'image_upload' && n.outputs.length > 0,
      ).length;

      const prompt =
        promptParts.length === 1
          ? promptParts[0]
          : promptParts.map((t, i) => `${i + 1}. ${t}`).join('\n');

      const type = node.type === 'video_gen' ? 'video' : 'image';
      const { generationId } = await media.createGeneration(
        ctx.sessionId,
        ctx.userId,
        type,
        prompt,
        referenceVersionIds.length ? referenceVersionIds : undefined,
      );
      // 回填 generationId：快照/前端据此显示生成状态与资产
      await canvas.applyOp(ctx.sessionId, 'agent', {
        op: 'update_node',
        nodeId: node.id,
        mediaGenerationId: generationId,
      });
      return JSON.stringify({
        generationId,
        status: 'queued',
        promptParts: promptParts.length,
        references: referenceVersionIds.length,
        // 明确回报被跳过的上游资源，模型不会误以为它们参与了生成
        skippedImageUpload: skippedUploads, // MVP 模拟上传，无 versionId 可引用
      });
    },
    {
      name: 'generate_media_node',
      description:
        '触发某个 image_gen / video_gen 节点的实际生成（异步）。素材全部取自入边：上游 text 节点的正文拼成提示词，上游 image_gen 的图片作参考图（视频取第一张当首帧）。生成节点自身不带 prompt——没有上游 text 就会报错，此时应先建 text 节点再连线。上游 image_upload 暂不参与生成（模拟上传无资产可引用），会在返回值里报出。触发后立即返回 queued，卡片状态自动更新，不要重复触发同一节点。',
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
