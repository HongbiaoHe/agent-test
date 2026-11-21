import { shortNodeId, type CanvasEdgeDto, type CanvasNodeDto } from './types';

/**
 * 注入给 agent 的「实时画布状态 + 放置安全区」文本（替代 agent 反复调用查询工具）。
 * 服务端画布 agent 与 desktop 本机 agent 共用这一份写法——两边的模型读到的是同一种格式，
 * 工具返回的短 id 也与这里一致。
 *
 * 首行固定以 CANVAS_STATE_MARKER 开头：注入中间件据此找出上一份、画布没变就不重复注入。
 */
export const CANVAS_STATE_MARKER = '## 当前画布实时状态';

export interface AgentCanvasInput {
  nodes: readonly CanvasNodeDto[];
  edges: readonly CanvasEdgeDto[];
  /** 用户「加入对话」圈定的节点；空 = 关注整块画布 */
  focusNodeIds: readonly string[];
}

export function buildAgentCanvasContext(snap: AgentCanvasInput): string {
  // 安全区 = 现有全部节点的**右侧或下方**：把新节点放进去即不与现有节点重叠。
  // 节点尺寸按卡片实际大小取保守值（W×H），留 GAP 间距。
  const W = 280;
  // 卡面 = 满宽画面（w-64 = 256px），高度随画幅：9:16 实测 457px，统一按 220 估会叠在一起。
  // 画幅取档位里的 aspect_ratio；上传 / 拼接 / 没设画幅的拿不到，按常见画幅里最高的 9:16 保守估。
  // H 是下限：横版卡比它矮，仍按 220 留位，不压缩原有间距
  const H = 220;
  const GAP = 40;
  const cardH = (aspect: number) => Math.max(H, Math.ceil(256 / aspect) + 2);
  const heightOf = (n: CanvasNodeDto) =>
    cardH(parseAspect(n.mediaParams?.aspect_ratio) ?? 9 / 16);
  const strides =
    `16:9 ≥ ${cardH(16 / 9) + GAP}px、1:1 ≥ ${cardH(1) + GAP}px、` +
    `9:16 ≥ ${cardH(9 / 16) + GAP}px（画幅未定按 9:16）`;

  // 用户圈定了节点（「加入对话」）→ 本段只列这些节点。大画布上用户往往只想让 agent 动其中几张卡，
  // 全量列出既淹没重点、又每次变化都要重付一份长快照。
  const focus = new Set(snap.focusNodeIds);
  const listed =
    focus.size > 0 ? snap.nodes.filter((n) => focus.has(n.id)) : snap.nodes;
  // 连线取「至少一端被圈中」的：只列两端都在圈内的话，模型看不到这些节点的上游从哪来
  const listedEdges =
    focus.size > 0
      ? snap.edges.filter((e) => focus.has(e.source) || focus.has(e.target))
      : snap.edges;

  // id 一律用短 id（完整 cuid 的后 6 位）：完整 id 会让本段膨胀近 3 倍，而这段每次画布变化都要
  // 追加一份进上下文。工具侧把短 id / 完整 id 都反解成完整 id。
  const nodeLines = listed.map((n) => {
    const desc = (n.label ?? n.prompt ?? '').slice(0, 30);
    const media = n.mediaStatus ? ` <生成:${n.mediaStatus}>` : '';
    // 只列显式设过的：没设 = 默认模型，不写省 token
    const model = n.mediaModel ? ` <模型:${n.mediaModel}>` : '';
    // 拼接节点标出当前顺序（= 成片顺序），agent 触发前能直接核对，不用从连线列表里推
    const order =
      n.type === 'video_concat' ? clipOrderTag(snap.nodes, snap.edges, n.id) : '';
    return `- ${shortNodeId(n.id)} [${n.type}] "${desc}" @(${Math.round(n.x)},${Math.round(n.y)})${media}${model}${order}`;
  });
  const edgeLines = listedEdges.map(
    (e) => `- ${shortNodeId(e.source)} → ${shortNodeId(e.target)}`,
  );

  // 安全区始终按**全部**节点算：只按圈中的算会让新节点压在圈外的节点上
  let safe: string;
  if (snap.nodes.length === 0) {
    safe = `画布为空。从 (40, 40) 开始布局：向右每列 +${W + GAP}px，向下每行按该行节点画幅：${strides}。`;
  } else {
    const rightX = Math.round(Math.max(...snap.nodes.map((n) => n.x + W))) + GAP;
    const belowY =
      Math.round(Math.max(...snap.nodes.map((n) => n.y + heightOf(n)))) + GAP;
    const topY = Math.round(Math.min(...snap.nodes.map((n) => n.y)));
    const leftX = Math.round(Math.min(...snap.nodes.map((n) => n.x)));
    safe =
      `现有节点占据区域：x∈[${leftX}, ${rightX - GAP}]、y∈[${topY}, ${belowY - GAP}]。\n` +
      `**新增节点必须放到安全区**（否则会与现有节点重叠）：右侧 x ≥ ${rightX}，或下方 y ≥ ${belowY}。\n` +
      `同批多个新节点之间：横向间隔 ≥ ${W + GAP}px；纵向间隔按上面那个节点的画幅：${strides}。` +
      `建议：接着现有节点向右新开一列，从 (${rightX}, ${topY}) 起向下依次排列。`;
  }

  const scope =
    focus.size > 0
      ? `\n\n### 关注范围\n用户已圈定 ${listed.length} 个节点加入本次对话，上面只列了这些节点` +
        `（画布上另有 ${snap.nodes.length - listed.length} 个节点未圈定，未列出）。\n` +
        `**请只对上面列出的节点动手**；确需改动其它节点时，先说明理由并请用户取消圈定。`
      : '';

  return (
    `${CANVAS_STATE_MARKER}（画布一有变化就自动追加最新一份，直接使用，无需调用任何工具查询画布）\n` +
    `节点（${listed.length}）：\n${nodeLines.join('\n') || '（无）'}\n\n` +
    `连线（${listedEdges.length}）：\n${edgeLines.join('\n') || '（无）'}\n\n` +
    `### 放置安全区（避免节点重叠）\n${safe}${scope}`
  );
}

/** 档位里的画幅（"16:9" / "9x16"）→ 宽高比，夹在 [1/2, 4]；认不出返回 null */
export function parseAspect(value: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i.exec(value ?? '');
  if (!m || Number(m[2]) <= 0) return null;
  return Math.min(Math.max(Number(m[1]) / Number(m[2]), 1 / 2), 4);
}

/** 拼接节点的当前顺序标注：` <拼接顺序: 短id「标题」 → …>`；没有上游返回空串 */
export function clipOrderTag(
  nodes: readonly { id: string; label: string | null; type: string }[],
  edges: readonly { source: string; target: string }[],
  nodeId: string,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clips = edges
    .filter((e) => e.target === nodeId)
    .map((e) => byId.get(e.source))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${shortNodeId(n.id)}「${n.label ?? n.type}」`);
  return clips.length > 0 ? ` <拼接顺序: ${clips.join(' → ')}>` : '';
}

/**
 * 把模型给的节点 id 解析成完整 id：完整 id 精确匹配；否则按后缀匹配（短 id），
 * 匹配不到或有歧义返回 null，由调用方报错给模型。
 */
export function resolveNodeIdIn(
  nodeIds: readonly string[],
  id: string,
): string | null {
  if (nodeIds.includes(id)) return id;
  const matched = nodeIds.filter((n) => n.endsWith(id));
  return matched.length === 1 ? matched[0] : null;
}
