"use client";

import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CanvasNodeDto, CanvasNodeType, CanvasOpInput } from "@/lib/api";

import type { CanvasState } from "../_lib/canvas-state";
import {
  canConnectNodeTypes,
  resolveNodeInputs,
  type NodeInputSource,
} from "../_lib/node-io";
import type { SaveState } from "../_hooks/use-canvas";
import { edgeTypes, type FlowEdgeData } from "./canvas-edges";
import { ConnectDropMenu, type ConnectDrop } from "./connect-drop-menu";
import { applyMagnet, releaseMagnet } from "./handle-magnet";
import { SelectionToolbar } from "./selection-toolbar";
import { nodeTypes } from "./canvas-nodes";
import { CanvasZoomControls } from "./canvas-zoom-controls";

/** 点端口「+」时告诉画布：从哪个节点、往哪个方向、在屏幕的哪个点接新节点。 */
export interface ConnectMenuRequest {
  nodeId: string;
  direction: "downstream" | "upstream";
  clientX: number;
  clientY: number;
}

/** 节点卡片宽度（canvas-nodes 的 w-64），拖线新建节点时用来算落位。 */
const NODE_WIDTH = 256;


/** 节点内容可编辑字段（update_node op 的子集，位置与 generationId 回填不在此列）。 */
export interface NodeContentPatch {
  label?: string;
  /** 生成节点的提示词（image_gen / video_gen 自己的字段） */
  prompt?: string;
  /** 生成节点的模型选择（面板上的模型 / 档位下拉，见 NodeModelControls） */
  mediaChannel?: string;
  mediaModel?: string;
  mediaParams?: Record<string, string>;
}

/**
 * 节点编辑上下文：react-flow 自定义节点只拿 data，编辑回调与保存状态经 context 注入
 * （canvas-nodes.tsx / node-editor-toolbar.tsx 消费）。
 * updateNode 落到 update_node op（revision CAS 自动保存）；saveStates 驱动 loading 反馈。
 */
export const CanvasEditorContext = createContext<{
  readOnly: boolean;
  updateNode: (nodeId: string, patch: NodeContentPatch) => void;
  saveStates: Record<string, SaveState>;
  /** 键入即亮 loading（防抖未到点也显示） */
  markSaving: (nodeId: string) => void;
  /** 内容回退到原值、最终无 op 可发 → 撤销 loading */
  cancelSaving: (nodeId: string) => void;
  /** 沿入边解析该节点的关联输入（浮窗展示用） */
  resolveInputs: (nodeId: string) => NodeInputSource[];
  /** 取消全部选中：手机上编辑抽屉关闭时要连带取消选中，否则 selected 还在、抽屉会立刻弹回 */
  clearSelection: () => void;
  /** 删除节点（落 remove_node op，服务端级联删相关边） */
  deleteNode: (nodeId: string) => void;
  /** 就地复制一个节点（落 add_node op，偏移 40px 放在原节点右下） */
  duplicateNode: (nodeId: string) => void;
  /** 重发一次失败的生成（节点卡片上的 Retry） */
  retryMedia: (generationId: string) => void;
  /** 用选定的模型生成一次（生成节点面板上的 Generate） */
  generateNode: (nodeId: string) => void;
  /** 触发视频拼接（video_concat 卡片上的 Merge） */
  mergeVideo: (nodeId: string) => void;
  /** 点端口上的「+」：在该处弹出「接一个什么节点」菜单（与拖到空白处同一个菜单） */
  openConnectMenu: (input: ConnectMenuRequest) => void;
  /** 选中并把视图移到某个节点上（如上游摘要里点某一路来源 → 跳到那张卡） */
  focusNode: (nodeId: string) => void;
  /** 「加入对话」圈定的节点 id：节点据此画圈定标记 */
  focusedNodeIds: ReadonlySet<string>;
  /** 当前选中的节点数：>1 时单个节点的编辑面板让位给多选工具条 */
  selectedCount: number;
  /** 多选手势进行中（框选拖拽中、或按住多选修饰键）：期间一律不弹单节点编辑面板 */
  multiSelecting: boolean;
  /** 当前选区是「按组选的」：即便只有一个节点，也走多选工具条而不是编辑面板 */
  groupSelect: boolean;
}>({
  readOnly: true,
  updateNode: () => {},
  saveStates: {},
  markSaving: () => {},
  cancelSaving: () => {},
  resolveInputs: () => [],
  clearSelection: () => {},
  deleteNode: () => {},
  duplicateNode: () => {},
  retryMedia: () => {},
  generateNode: () => {},
  mergeVideo: () => {},
  openConnectMenu: () => {},
  focusNode: () => {},
  focusedNodeIds: new Set<string>(),
  selectedCount: 0,
  multiSelecting: false,
  groupSelect: false,
});

/**
 * 画布投影 → react-flow 节点。**增量**：没变的节点原样复用上一份对象。
 *
 * 为什么不能整表重建：react-flow 把实测尺寸（`measured`）存在节点对象上。每次换新对象都会
 * 把它丢掉，节点要重新量一遍，那一帧连线按缺省尺寸画 → 整张画布闪一下。而 canvas 的任何变化
 * 都会触发这里——agent 加一条**边**、媒体状态刷新，都会让全部节点跟着重建，于是"agent 连线时
 * 画布闪烁"。
 *
 * 「没变」的判定靠 `seen`——上一轮各节点对应的 DTO 引用表。applyPatch 是不可变更新，没动到的
 * 节点 DTO 引用不变，一次引用比较即可。不把 DTO 直接放进 `data`（那样最省事）是因为
 * react-flow 的 `Node.data` 要求 `Record<string, unknown>`，而 DTO 是没有索引签名的 interface。
 */
function syncRfNodes(
  prev: Node[],
  canvas: CanvasState,
  seen: Map<string, CanvasNodeDto>,
): Node[] {
  const byId = new Map(prev.map((n) => [n.id, n]));
  let changed = prev.length !== canvas.nodes.length;
  const next = canvas.nodes.map((dto, i) => {
    const old = byId.get(dto.id);
    if (old && seen.get(dto.id) === dto) {
      // 顺序也没变才算完全没动（节点顺序决定叠放层级）
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    // 复用旧对象的其余字段：selected / measured / dragging 都在上面，重建会把它们抹掉
    return old
      ? {
          ...old,
          type: dto.type,
          position: { x: dto.x, y: dto.y },
          data: { ...dto },
        }
      : {
          id: dto.id,
          type: dto.type,
          position: { x: dto.x, y: dto.y },
          data: { ...dto },
        };
  });
  seen.clear();
  for (const dto of canvas.nodes) seen.set(dto.id, dto);
  // 一个都没动就连数组引用一起复用，省掉一次 react-flow 的整表 diff
  return changed ? next : prev;
}

/** 画布投影 → react-flow 连线。同样增量，理由见 syncRfNodes。 */
function syncRfEdges(prev: Edge[], canvas: CanvasState): Edge[] {
  // 目标节点正在生成 → 该入边常驻流光（表现数据正流入这个节点）
  const generating = new Set(
    canvas.nodes.filter((n) => n.mediaStatus === "generating").map((n) => n.id),
  );
  const byId = new Map(prev.map((e) => [e.id, e]));
  let changed = prev.length !== canvas.edges.length;
  const next = canvas.edges.map((e, i) => {
    const busy = generating.has(e.target);
    const old = byId.get(e.id);
    if (
      old &&
      old.source === e.source &&
      old.target === e.target &&
      (old.data as FlowEdgeData | undefined)?.busy === busy
    ) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "flow",
      // active 由下方 flowEdges 按选中态派生，这里保留住不要抹掉
      data: { ...(old?.data as FlowEdgeData | undefined), busy },
    };
  });
  return changed ? next : prev;
}

/**
 * 保存状态徽标（画布左上角，全画布唯一一处）：聚合所有节点的 update_node 状态。
 * 任一节点在保存 → 保存中；否则有失败 → 失败；否则刚成功 → 已保存；都没有则不渲染。
 */
/**
 * 首帧聚焦：快照异步落地时 mount 时点节点为空，<ReactFlow fitView> 落空——
 * 首次节点从空变非空后补一次 fitView。一次性（ref），随 FlowCanvas key=sessionId 重挂载重置。
 */
function FitOnFirstLoad({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || count === 0) return;
    done.current = true;
    // 下一帧执行：等本次渲染的节点 DOM 就位再取包围盒
    requestAnimationFrame(() => {
      void fitView({ padding: 0.2, maxZoom: 1.2 });
    });
  }, [count, fitView]);
  return null;
}

/**
 * agent 操控期，把**刚发生的改动**聚焦到画布窗口中央（而非 fit 全部）。必须作为 <ReactFlow>
 * 子组件才能拿到上下文。
 *
 * 算进这一批的有两类：
 *  - **新增的节点**——例如新增 3 个节点，就把这 3 个居中展示；
 *  - **新增连线的目标节点**——连线同样是"这一步做了什么"，只连线不建节点时（把已有的两个
 *    节点接起来）原先画面纹丝不动，用户不知道刚发生了什么。聚焦目标端而不是两端：连线的语义
 *    是"数据流向它"，落点才是这一步的结果。目标节点本轮就是新建的话，Set 天然去重。
 *
 * 首次挂载只记录基线不聚焦（初始视图由 fitView prop 处理）；空闲期不自动聚焦，避免打断用户平移。
 */
function FitOnChange({
  nodeIdsKey,
  edgeTargetsKey,
  active,
}: {
  /** 当前全部节点 id 以 '|' 连接（仅在节点集合增删时变化，拖拽/选中不变）。 */
  nodeIdsKey: string;
  /** 当前全部连线的 `边id>目标节点id`，以 '|' 连接（仅在连线集合增删时变化）。 */
  edgeTargetsKey: string;
  active: boolean;
}) {
  const { fitView } = useReactFlow();
  // 基线：上次已聚焦（或初始/空闲对齐）的节点集合。只在真正聚焦后推进。
  const baseIds = useRef<Set<string> | null>(null);
  // 固定收集窗口计时器：**第一个新节点到达时开一个 500ms 窗口，期间不重置**；
  // 窗口结束时把这 500ms 内新增的所有节点作为一批一起聚焦。
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 连线基线，与节点同一套：上次已聚焦（或对齐）的连线 id 集合
  const baseEdgeIds = useRef<Set<string> | null>(null);
  // 最新的两个键（供窗口到点时读取窗口内累积到的最新状态，而非窗口开始时的快照）。
  const latestKey = useRef(nodeIdsKey);
  const latestEdgeKey = useRef(edgeTargetsKey);

  useEffect(() => {
    latestKey.current = nodeIdsKey;
    latestEdgeKey.current = edgeTargetsKey;
    const ids = nodeIdsKey ? nodeIdsKey.split("|") : [];
    const edgePairs = edgeTargetsKey ? edgeTargetsKey.split("|") : [];
    const edgeIds = edgePairs.map((p) => p.split(">")[0]);
    if (baseIds.current === null) {
      // 首次记基线，不聚焦
      baseIds.current = new Set(ids);
      baseEdgeIds.current = new Set(edgeIds);
      return;
    }
    if (!active) {
      // 空闲期不聚焦，对齐基线；若有未结束的窗口一并取消
      baseIds.current = new Set(ids);
      baseEdgeIds.current = new Set(edgeIds);
      if (windowTimer.current) {
        clearTimeout(windowTimer.current);
        windowTimer.current = null;
      }
      return;
    }
    const addedNodes = ids.filter((id) => !baseIds.current!.has(id));
    const addedEdges = edgeIds.filter((id) => !baseEdgeIds.current!.has(id));
    // 无新增，或 500ms 收集窗口已在计时（本次新增会在窗口到点时被计入）→ 不新开窗口
    if ((addedNodes.length === 0 && addedEdges.length === 0) || windowTimer.current) {
      return;
    }
    windowTimer.current = setTimeout(() => {
      windowTimer.current = null;
      const curIds = latestKey.current ? latestKey.current.split("|") : [];
      const curPairs = latestEdgeKey.current
        ? latestEdgeKey.current.split("|")
        : [];
      const base = baseIds.current ?? new Set<string>();
      const baseEdges = baseEdgeIds.current ?? new Set<string>();
      const alive = new Set(curIds);
      // 窗口内累积的全部新增节点 + 新增连线的目标端（目标节点可能已被删掉 → 用 alive 过滤）
      const batch = new Set(curIds.filter((id) => !base.has(id)));
      for (const pair of curPairs) {
        const [edgeId, target] = pair.split(">");
        if (!baseEdges.has(edgeId) && alive.has(target)) batch.add(target);
      }
      baseIds.current = new Set(curIds);
      baseEdgeIds.current = new Set(curPairs.map((p) => p.split(">")[0]));
      if (batch.size === 0) return;
      void fitView({
        nodes: [...batch].map((id) => ({ id })),
        padding: 0.35,
        duration: 500,
        maxZoom: 1.2,
      });
    }, 500);
  }, [nodeIdsKey, edgeTargetsKey, active, fitView]);

  // 卸载时清理未结束的窗口计时器
  useEffect(
    () => () => {
      if (windowTimer.current) clearTimeout(windowTimer.current);
    },
    [],
  );
  return null;
}

interface FlowCanvasProps {
  canvas: CanvasState;
  readOnly: boolean;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onApplyOp: (op: CanvasOpInput) => void;
  /** update_node 保存状态（nodeId → saving/saved/error），驱动画布左上角保存指示 */
  saveStates: Record<string, SaveState>;
  /** 键入即亮 loading（防抖窗口内也显示） */
  onMarkSaving: (nodeId: string) => void;
  /** 内容回退到原值、无 op 可发 → 撤销 loading */
  onCancelSaving: (nodeId: string) => void;
  /** 点画布空白处（不含节点/连线）：桌面端据此收起未钉住的悬浮面板 */
  onPaneClick?: () => void;
  /** 重发一次失败的生成（节点卡片上的 Retry） */
  onRetryMedia: (generationId: string) => void;
  /** 用选定的模型生成一次（生成节点面板上的 Generate） */
  onGenerateNode: (nodeId: string) => void;
  /** 触发视频拼接（video_concat 卡片上的 Merge） */
  onMergeVideo: (nodeId: string) => void;
  /** 快照还没落地：此时节点为空是"还没加载"，不是"这块画布是空的" */
  loading: boolean;
  /** 「加入对话」圈定的节点 id（空 = 关注整块画布） */
  focusNodeIds: string[];
  /** 设置 / 清空圈定（传空数组即取消） */
  onSetFocus: (nodeIds: string[]) => void;
  /** 新建节点：fromId 有值就顺带接好线，为 null 则是空白处右键的孤立新建 */
  onAddConnectedNode: (input: {
    fromId: string | null;
    direction: "downstream" | "upstream";
    type: CanvasNodeType;
    x: number;
    y: number;
    /** 新节点的初始正文（生成节点面板里直接写提示词时用） */
    text?: string;
  }) => void;
}

/**
 * 外层只负责挂 ReactFlowProvider：内层要用 useReactFlow 做「屏幕坐标 → 画布坐标」的换算
 * （拖线到空白处新建节点时用），而那个 hook 必须在 provider 之内、且不能与 <ReactFlow>
 * 在同一个组件里调用。
 */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({
  canvas,
  readOnly,
  onMoveNode,
  onApplyOp,
  saveStates,
  onMarkSaving,
  onCancelSaving,
  onPaneClick,
  onRetryMedia,
  onGenerateNode,
  onMergeVideo,
  loading,
  focusNodeIds,
  onSetFocus,
  onAddConnectedNode,
}: FlowCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // 拖线松手在空白处 → 记下落点，弹出「接一个什么节点」菜单（见 ConnectDropMenu）
  const [drop, setDrop] = useState<ConnectDrop | null>(null);

  /**
   * 多选手势是否进行中。
   *
   * 框选框扫过第一个节点的那一刻 selectedCount 恰好是 1，单节点编辑面板就会当场弹出来
   * 挡住后面还要框的节点，框到第二个又消失——一次多选要闪一下。按住多选修饰键逐个点选同理。
   * 手势期间一律压住面板，松手后若最终只选中一个，再照常浮出。
   *
   * 修饰键取 shift / meta / ctrl 三者：react-flow 的 selectionKeyCode（框选）默认 Shift，
   * multiSelectionKeyCode（点选累加）默认 Meta(mac) / Control。
   */
  const [multiSelecting, setMultiSelecting] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) =>
      setMultiSelecting(e.shiftKey || e.metaKey || e.ctrlKey);
    // 切窗口时按键抬起收不到，回来会一直压着面板 —— 失焦即复位
    const reset = () => setMultiSelecting(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, setCenter, getZoom, getNodes } = useReactFlow();

  /**
   * 松手位置压着哪个节点。
   *
   * 不能用 DOM 命中测试（elementFromPoint / event.target）：连线拖拽期间 react-flow 会让
   * .react-flow__pane 接管指针，卡片在那一刻根本命不中——问出来永远是 pane。
   * react-flow 自己判断端口也不走 DOM，而是拿存好的端口坐标算距离。
   * 这里同理：把落点换算成画布坐标，再去比各节点的矩形（尺寸取 react-flow 实测的 measured）。
   */
  const nodeAtPointer = useCallback(
    (clientX: number, clientY: number): string | null => {
      const p = screenToFlowPosition({ x: clientX, y: clientY });
      // 从后往前找：后渲染的画在上面，重叠时该取压在最上面那张
      const hit = [...getNodes()]
        .reverse()
        .find((n) => {
          const w = n.measured?.width ?? NODE_WIDTH;
          const h = n.measured?.height ?? 0;
          return (
            p.x >= n.position.x &&
            p.x <= n.position.x + w &&
            p.y >= n.position.y &&
            p.y <= n.position.y + h
          );
        });
      return hit?.id ?? null;
    },
    [screenToFlowPosition, getNodes],
  );

  // 外部画布状态（快照 / canvas_patch / media 刷新）变化时增量同步 RF 视图。
  // 本地拖拽不改 canvas，故不会在拖拽中被打断。
  // 逐节点复用而非整表重建：既保住 selected（update_node 回广播时正在编辑的浮窗不会消失），
  // 也保住 measured（丢了要重新量，那一帧连线按缺省尺寸画 → 画布闪烁）。详见 syncRfNodes。
  // 上一轮各节点的 DTO 引用：syncRfNodes 据此判断"这个节点没变"（见该函数注释）
  const seenDtos = useRef<Map<string, CanvasNodeDto>>(new Map());
  useEffect(() => {
    setNodes((prev) => syncRfNodes(prev, canvas, seenDtos.current));
  }, [canvas, setNodes]);
  useEffect(() => {
    setEdges((prev) => syncRfEdges(prev, canvas));
  }, [canvas, setEdges]);

  // 用 join 出的字符串做依赖：父级每次渲染都会给一个新数组，直接依赖数组会让 memo 永远失效
  const focusKey = focusNodeIds.join("|");
  const focusSet = useMemo(
    () => new Set(focusKey ? focusKey.split("|") : []),
    [focusKey],
  );

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected),
    [nodes],
  );

  // 选中节点的全部关联连线（进+出）也做强调。选中态只存在于 RF 本地 state，故在这里派生而不进
  // toRfEdges；用 id 串成 key 而不是直接依赖 nodes——nodes 每个拖拽帧都变，否则每帧重算。
  const selectedKey = selectedNodes
    .map((n) => n.id)
    .sort()
    .join("|");
  const flowEdges = useMemo(() => {
    const selected = new Set(selectedKey ? selectedKey.split("|") : []);
    return edges.map((e) => {
      const data: FlowEdgeData = e.data ?? {};
      const active =
        data.busy === true || selected.has(e.source) || selected.has(e.target);
      // 无变化就返回原对象，避免每次渲染都给 react-flow 换新引用
      return active === (data.active ?? false)
        ? e
        : { ...e, data: { ...data, active } };
    });
  }, [edges, selectedKey]);

  /**
   * 这一份选区是「按组选的」还是「点开来编辑的」。
   *
   * 按住修饰键 / 框选出来的**哪怕只有一个节点**，用户要的也是把它加进对话、复制或删除
   * （多选工具条），而不是编辑它——所以不能只按数量分。
   *
   * 判定发生在**选区变成现在这样的那一刻**：那一刻按着多选修饰键就算按组选的，并一直保持
   * 到选区再次变化。于是松开 shift 不会把一组选择变回编辑态；改用普通点击另选一个则回到编辑态。
   * 在渲染期收敛（不是 useEffect —— react-hooks/set-state-in-effect 在本项目是 error 级）。
   */
  const [groupPick, setGroupPick] = useState({ key: "", group: false });
  if (groupPick.key !== selectedKey) {
    setGroupPick({ key: selectedKey, group: !!selectedKey && multiSelecting });
  }
  const groupSelect = groupPick.group && selectedNodes.length > 0;


  // 记下一次「要在哪里接个新节点」：拖线松手在空白处、点端口上的「+」、或在空白处右键，
  // 都走这里。下游节点从落点向右铺开；上游节点要"结束"在落点上，故整卡左移一个卡宽。
  const openDropAt = useCallback(
    (
      /** null = 空白处右键：不接线，就地建一个孤立节点 */
      fromId: string | null,
      direction: "downstream" | "upstream",
      clientX: number,
      clientY: number,
    ) => {
      const from = fromId ? canvas.nodes.find((n) => n.id === fromId) : null;
      if (fromId && !from) return;
      const box = wrapRef.current?.getBoundingClientRect();
      const flow = screenToFlowPosition({ x: clientX, y: clientY });
      setDrop({
        fromId,
        fromType: from?.type ?? null,
        direction,
        flow: from
          ? {
              x:
                direction === "downstream"
                  ? flow.x + 24
                  : flow.x - NODE_WIDTH - 24,
              y: flow.y - 16,
            }
          : // 右键新建：卡片以指针为中心落下，指到哪儿建到哪儿
            { x: flow.x - NODE_WIDTH / 2, y: flow.y - 16 },
        screen: { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) },
      });
    },
    [canvas, screenToFlowPosition],
  );

  /**
   * 端点磁吸（见 handle-magnet.ts）。挂在画布容器上而不是每张卡片上：触发范围有一半落在
   * 卡片外面，挂在卡片上从外侧靠近永远不触发。被吸住的端点记在 ref 里，下一帧只清它们。
   */
  const magnetized = useRef<Set<HTMLElement>>(new Set());
  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const root = wrapRef.current;
      if (!root) return;
      const pointer = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      magnetized.current = applyMagnet(
        root,
        pointer,
        getNodes().map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.measured?.width ?? NODE_WIDTH,
          height: n.measured?.height ?? 0,
        })),
        magnetized.current,
      );
      // 进了范围就把指针换成十字（「这里能拉线」），出去还原
      root.style.cursor = magnetized.current.size > 0 ? "crosshair" : "";
    },
    [screenToFlowPosition, getNodes],
  );
  const onCanvasPointerLeave = useCallback(() => {
    releaseMagnet(magnetized.current);
    magnetized.current = new Set();
    if (wrapRef.current) wrapRef.current.style.cursor = "";
  }, []);

  /**
   * 拖动落点入库。
   *
   * 必须遍历「本次被拖动的全部节点」而不是被按住的那一个：多选后拖动时 react-flow 会把整组
   * 一起搬走，但 onNodeDragStop 的第二个参数只有被按住的那张卡——只落它一个的话，松手时画面
   * 看着都挪了，刷新一看其余全弹回原位（位置是 LWW 落库，本地状态并不是事实来源）。
   */
  const persistDrag = useCallback(
    (dragged: Node[]) => {
      if (readOnly) return;
      // d3-drag 对「按下即松开」的纯点击同样发 dragStop：位置没变的不算拖动，
      // 不发无意义的 move_node op（也保持选中，让编辑面板照常浮出）。
      const moved = dragged.filter((n) => {
        const origin = canvas.nodes.find((x) => x.id === n.id);
        return (
          !!origin &&
          (origin.x !== n.position.x || origin.y !== n.position.y)
        );
      });
      if (moved.length === 0) return;
      for (const n of moved) onMoveNode(n.id, n.position.x, n.position.y);
      // 单张卡拖完取消选中，别让编辑面板跟着弹出来；整组拖动则保留选区——
      // 多选工具条还要用，且"拖完还选着"是同类工具的通行行为。
      if (moved.length === 1) {
        const id = moved[0].id;
        setNodes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, selected: false } : n)),
        );
      }
    },
    [readOnly, canvas, onMoveNode, setNodes],
  );

  /**
   * 选中某个节点并把视图挪过去（如上游摘要里点某一路来源 → 跳到提供它的那张卡）。
   * 保持当前缩放：跳转是「看一眼上游」，把人的缩放层级换掉会让人丢失方位感。
   */
  const focusNodeOnCanvas = useCallback(
    (nodeId: string) => {
      const n = canvas.nodes.find((x) => x.id === nodeId);
      if (!n) return;
      setNodes((prev) =>
        prev.map((x) => ({ ...x, selected: x.id === nodeId })),
      );
      setCenter(n.x + NODE_WIDTH / 2, n.y + 80, {
        zoom: getZoom(),
        duration: 400,
      });
    },
    [canvas, setNodes, setCenter, getZoom],
  );

  // 复制节点：落一条 add_node op，位置右下偏移 40px。
  // 只带可编辑内容（label/text/assetPath），生成态与媒资**不**随副本走——
  // 副本是一份新素材，指向同一份 generation 会让两张卡的状态互相打架。
  // 快捷键（Cmd/Ctrl+D）与卡片上的复制键共用它，行为保持一致。
  const duplicateFromCanvas = useCallback(
    (nodeId: string) => {
      const n = canvas.nodes.find((x) => x.id === nodeId);
      if (!n) return;
      onApplyOp({
        op: "add_node",
        type: n.type,
        label: n.label ?? undefined,
        prompt: n.prompt ?? undefined,
        assetPath: n.assetPath ?? undefined,
        x: n.x + 40,
        y: n.y + 40,
      });
    },
    [canvas, onApplyOp],
  );

  // 节点编辑上下文（canvas-nodes / node-editor-toolbar 消费）：
  // 内容变更 → update_node op 自动保存；saveStates 供浮窗与节点角标显示进度
  const editor = useMemo(
    () => ({
      readOnly,
      updateNode: (nodeId: string, patch: NodeContentPatch) =>
        onApplyOp({ op: "update_node", nodeId, ...patch }),
      saveStates,
      markSaving: onMarkSaving,
      cancelSaving: onCancelSaving,
      resolveInputs: (nodeId: string) => resolveNodeInputs(canvas, nodeId),
      clearSelection: () =>
        setNodes((prev) =>
          prev.some((n) => n.selected)
            ? prev.map((n) => (n.selected ? { ...n, selected: false } : n))
            : prev,
        ),
      deleteNode: (nodeId: string) =>
        onApplyOp({ op: "remove_node", nodeId }),
      duplicateNode: duplicateFromCanvas,
      retryMedia: onRetryMedia,
      generateNode: onGenerateNode,
      mergeVideo: onMergeVideo,
      openConnectMenu: (r: ConnectMenuRequest) =>
        openDropAt(r.nodeId, r.direction, r.clientX, r.clientY),
      focusNode: focusNodeOnCanvas,
      focusedNodeIds: focusSet,
      selectedCount: selectedNodes.length,
      multiSelecting,
      groupSelect,
    }),
    [
      readOnly,
      onApplyOp,
      saveStates,
      onMarkSaving,
      onCancelSaving,
      canvas,
      setNodes,
      duplicateFromCanvas,
      onRetryMedia,
      onGenerateNode,
      onMergeVideo,
      openDropAt,
      focusNodeOnCanvas,
      focusSet,
      selectedNodes.length,
      multiSelecting,
      groupSelect,
    ],
  );

  // Cmd/Ctrl+D 快捷复制选中节点（与卡片上的复制键同一套 duplicateFromCanvas）。
  // window 级监听 + 输入场景守卫：react-flow 面板焦点不稳定，元素级 onKeyDown 会漏事件。
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "d") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return; // 正在输入：不劫持
      }
      const selected = nodesRef.current.filter((n) => n.selected);
      if (selected.length === 0) return; // 无选中：保留浏览器默认行为
      e.preventDefault();
      for (const n of selected) duplicateFromCanvas(n.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, duplicateFromCanvas]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onPointerMove={onCanvasPointerMove}
      onPointerLeave={onCanvasPointerLeave}
    >
      <CanvasEditorContext.Provider value={editor}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={onPaneClick}
        /* 空白处右键 = 就地建节点。原本只有双击建 text 一条路，建生图/生视频节点无从下手。
           preventDefault 挡掉浏览器原生右键菜单，否则两张菜单会叠在一起。 */
        onPaneContextMenu={(e) => {
          if (readOnly) return;
          e.preventDefault();
          openDropAt(null, "downstream", e.clientX, e.clientY);
        }}
        // 第三个参数才是本次真正被拖动的**全部**节点；第二个只是被按住的那一个
        onNodeDragStop={(_e, _node, dragged) => persistDrag(dragged)}
        // 拖选区框（而不是拖某个节点）移动整组时走这条
        onSelectionDragStop={(_e, dragged) => persistDrag(dragged)}
        /* 框选拖拽的起止：修饰键在拖框途中被松开时，键盘那一路就压不住了，这里兜底 */
        onSelectionStart={() => setMultiSelecting(true)}
        onSelectionEnd={() => setMultiSelecting(false)}
        onConnect={(c: Connection) => {
          if (readOnly || !c.source || !c.target) return;
          onApplyOp({ op: "add_edge", source: c.source, target: c.target });
        }}
        /* 拖线没落在合法端口上（isValid 为假，含"松手在空白处"）→ 不是失败，是"想接个新节点"。
           记下落点让 ConnectDropMenu 接管；候选按端口契约过滤，选完自动落位并接线。 */
        onConnectEnd={(event, state) => {
          if (readOnly || state.isValid || !state.fromNode) return;
          const upstream = state.fromHandle?.type === "target";

          // 松手时落在某个节点身上 → 就接它，不必精确命中那颗小圆点。
          // 端口只有 12px 见方，而卡片有 256px 宽；对不准就前功尽弃、要重拖一次，
          // 是这类画布最容易让人烦躁的一处。整张卡片都是落点，才谈得上"吸附"。
          //
          // 落点自己反查而不是用 state.toNode —— 后者只在指针**压在端口上**
          // （或落在 connectionRadius 内）时才有值，停在卡面中间时是 null。
          const p = "changedTouches" in event ? event.changedTouches[0] : event;
          if (!p) return;
          const toId = nodeAtPointer(p.clientX, p.clientY);
          if (toId && toId !== state.fromNode.id) {
            const source = upstream ? toId : state.fromNode.id;
            const target = upstream ? state.fromNode.id : toId;
            const src = canvas.nodes.find((n) => n.id === source);
            const dst = canvas.nodes.find((n) => n.id === target);
            // 接不了就什么都不做：这张卡在拖拽期已经被压暗标成"接不了"
            // （见 canvas-nodes 的 useConnectFit），此时再弹新建菜单只会答非所问。
            if (src && dst && canConnectNodeTypes(src.type, dst.type)) {
              onApplyOp({ op: "add_edge", source, target });
            }
            return;
          }

          // 落在空白处 → 「想接个新节点」，交给 ConnectDropMenu
          openDropAt(
            state.fromNode.id,
            upstream ? "upstream" : "downstream",
            p.clientX,
            p.clientY,
          );
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        /* 删除必须落 remove_node op：onNodesChange 只改本地 react-flow 状态，
           服务端不知情，刷新或下一条 canvas_patch 一到节点就回来了。
           运行期把删除键关掉（deleteKeyCode=null），与其它结构编辑一致只读。 */
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        /* 用 onDelete 而不是 onNodesDelete + onEdgesDelete：一次拿到本次删除的节点与边，
           不必靠 selected 反推谁正在被删。
           过滤「两端有节点同时被删」的边：服务端 remove_node 已级联删掉它们，再发
           remove_edge 只是多一轮必然 404/无效的请求。 */
        onDelete={({ nodes: goneNodes, edges: goneEdges }) => {
          if (readOnly) return;
          const dying = new Set(goneNodes.map((n) => n.id));
          for (const n of goneNodes) {
            onApplyOp({ op: "remove_node", nodeId: n.id });
          }
          for (const e of goneEdges) {
            if (dying.has(e.source) || dying.has(e.target)) continue;
            onApplyOp({ op: "remove_edge", edgeId: e.id });
          }
        }}
        /* 触控板双指滚动 = 平移画布（panOnScroll）；关掉 zoomOnScroll 让双指滚动只平移不缩放。
           缩放仍可：捏合(zoomOnPinch 默认开) / Cmd+滚动(zoomActivationKeyCode 默认 Meta) / 左下缩放键。
           拖拽平移(panOnDrag 默认开)保留。 */
        /* 拖线时就按类型契约拦掉非法连接（后端 add_edge 也会校验，这里只是不让用户白拖一趟）。
           isValidConnection 在拖拽过程中被反复调用，故直接查 canvas.nodes 不做额外状态。 */
        isValidConnection={(c) => {
          if (!c.source || !c.target || c.source === c.target) return false;
          const src = canvas.nodes.find((n) => n.id === c.source);
          const dst = canvas.nodes.find((n) => n.id === c.target);
          return !!src && !!dst && canConnectNodeTypes(src.type, dst.type);
        }}
        /* 端口捕捉半径（默认 20）：拖线走到端口附近就吸上去，不用压着那颗圆点松手。
           没有放得更大是因为卡片左右两侧各有一个端口，半径过大会吸错边。 */
        connectionRadius={40}
        panOnScroll
        zoomOnScroll={false}
        /* 空白处双击不做任何事：建节点走右键菜单 / 端口拖线 / agent，缩放走捏合 / Cmd+滚动 /
           左下缩放键。留着双击缩放会和媒体卡的「双击看大图」抢同一个手势，误触就是一次视口跳变 */
        zoomOnDoubleClick={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <CanvasZoomControls />
        {/* 首帧聚焦：快照落地后补一次 fitView（修"切画布空白"） */}
        <FitOnFirstLoad count={nodes.length} />
        {/* 选区工具条：≥2 个，或「按组选中」的单个（shift 点选/框选出来的那一个，
            用户要的是把它加进对话，不是编辑它） */}
        {!readOnly && (selectedNodes.length >= 2 || groupSelect) && (
          <SelectionToolbar
            nodes={selectedNodes}
            focused={
              selectedNodes.length > 0 &&
              selectedNodes.every((n) => focusNodeIds.includes(n.id))
            }
            onAddToChat={() => {
              const ids = selectedNodes.map((n) => n.id);
              const already = ids.every((id) => focusNodeIds.includes(id));
              onSetFocus(already ? [] : ids);
            }}
            onDuplicate={() => {
              for (const n of selectedNodes) duplicateFromCanvas(n.id);
            }}
            onDelete={() => {
              for (const n of selectedNodes) {
                onApplyOp({ op: "remove_node", nodeId: n.id });
              }
            }}
          />
        )}
        {/* agent 操控期：把刚新增的节点、以及刚连上的连线目标端聚焦到画布中央 */}
        <FitOnChange
          nodeIdsKey={nodes.map((n) => n.id).join("|")}
          edgeTargetsKey={edges.map((e) => `${e.id}>${e.target}`).join("|")}
          active={readOnly}
        />
      </ReactFlow>
      </CanvasEditorContext.Provider>
      {/* 空画布：给一句话说清怎么开始。不画插画、不放大图标——画布本身才是主角 */}
      {!loading && nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm text-muted-foreground">
            {readOnly ? "The agent is setting things up…" : "This canvas is empty"}
          </p>
          {!readOnly && (
            <p className="text-xs text-muted-foreground/70">
              Right-click anywhere to add a node, or ask the agent to build the
              board for you.
            </p>
          )}
        </div>
      )}
      {drop && (
        <ConnectDropMenu
          drop={drop}
          onDismiss={() => setDrop(null)}
          onPick={(type) => {
            setDrop(null);
            onAddConnectedNode({
              fromId: drop.fromId,
              direction: drop.direction,
              type,
              x: drop.flow.x,
              y: drop.flow.y,
            });
          }}
        />
      )}
      {/* 四周呼吸式光晕：表现 AI 正在奋力操控画布（动效见 globals.css .canvas-working-overlay）。
          「Agent working / 只读」的文字状态在顶部 header 里，不在画布内 */}
      {readOnly && <div className="canvas-working-overlay" aria-hidden />}
    </div>
  );
}
