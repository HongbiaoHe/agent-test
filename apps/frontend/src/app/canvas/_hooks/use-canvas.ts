"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  appendCanvasMessage,
  applyCanvasOp,
  clearCanvasMessages,
  clearCanvasPlan,
  getCanvasMessages,
  getCanvasSnapshot,
  moveCanvasNode,
  regenerateMedia,
  setCanvasFocus,
  stopCanvas,
  type CanvasNodeType,
  type CanvasOpInput,
  type CanvasPatch,
} from "@/lib/api";
import {
  respondCanvasControl,
  subscribeCanvas,
  type CanvasEvent,
} from "@/lib/socket";

import { buildDecisions } from "../_lib/ask-decisions";
import { applyPatch, type CanvasState } from "../_lib/canvas-state";
import {
  buildBaseChat,
  emptyChat,
  foldChat,
  type ChatEvent,
} from "../_lib/chat";

const EMPTY_CANVAS: CanvasState = { nodes: [], edges: [], revision: 0 };
/** 稳定的空数组：每次渲染新建 [] 会让下游 memo/effect 白白失效 */
const EMPTY_FOCUS: string[] = [];
const BUSY = new Set(["queued", "running", "waiting_approval"]);

/** update_node 保存状态（按 nodeId）：saving 在途 / saved 刚成功 / error 失败已重拉快照 */
export type SaveState = "saving" | "saved" | "error";
/** 终态自动消失延时（毫秒） */
const SAVED_LINGER_MS = 1500;
const ERROR_LINGER_MS = 3000;

/**
 * 单个画布会话的完整状态编排：
 * - 画布投影 ← GET /canvas/:id 快照（基底）+ socket canvas_patch 增量
 * - 聊天 ← GET /canvas/:id/messages（基底）+ socket 对话事件折叠
 * - token 累计 ← token_usage 事件
 * 运行期只读（busy）；空闲期用户结构编辑带 baseRevision，409 重拉。
 */
export function useCanvas(sessionId: string | null) {
  const qc = useQueryClient();

  const snapQ = useQuery({
    queryKey: ["canvas", sessionId],
    queryFn: () => getCanvasSnapshot(sessionId as string),
    enabled: !!sessionId,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const msgQ = useQuery({
    queryKey: ["canvas-messages", sessionId],
    queryFn: () => getCanvasMessages(sessionId as string),
    enabled: !!sessionId,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // —— 画布投影：快照作基底（seed），patch 增量应用 ——
  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_CANVAS);
  // token 累计：快照持久化总量作基底，token_usage 事件（会话级累计）覆盖。
  // 声明须在下方快照 sync 块之前（块内 setTokens 在渲染期执行，避免 TDZ）。
  const [tokens, setTokens] = useState(0);
  const snapKey = `${sessionId ?? ""}:${snapQ.dataUpdatedAt}`;
  const [trackedSnap, setTrackedSnap] = useState("");
  if (trackedSnap !== snapKey) {
    setTrackedSnap(snapKey);
    setCanvas(
      snapQ.data
        ? {
            nodes: snapQ.data.nodes,
            edges: snapQ.data.edges,
            revision: snapQ.data.revision,
          }
        : EMPTY_CANVAS,
    );
    // token 以快照的持久化总量为基底（切会话不残留旧值、刷新不归零）；
    // 运行期 token_usage 事件（会话级累计口径）随后覆盖
    setTokens(snapQ.data?.totalTokens ?? 0);
  }

  // —— 聊天：历史基底 + 实时增量折叠 ——
  const [liveChat, setLiveChat] = useState<ChatEvent[]>([]);
  const msgKey = `${sessionId ?? ""}:${msgQ.dataUpdatedAt}`;
  const [trackedMsg, setTrackedMsg] = useState("");
  if (trackedMsg !== msgKey) {
    setTrackedMsg(msgKey);
    setLiveChat([]);
  }

  const [pending, setPending] = useState(false);
  // 清空会话请求在途（按钮转圈禁用）
  const [clearing, setClearing] = useState(false);

  // update_node 保存状态（按 nodeId）：inflight 计数聚合连续编辑，
  // 避免防抖多次提交时先返回的响应提前把 loading 清掉。
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const inflight = useRef<Record<string, number>>({});
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // 最新已知 revision：CAS 基线。必须用 ref 而非闭包里的 canvas.revision——
  // 连续编辑（改完标题接着改正文）时 React 还没重渲染、socket patch 也可能还没到，
  // 用旧 revision 发第二个 op 必然 409（实测表现为"保存失败"）。
  // 来源两处：本地 canvas 同步（含 patch/快照）+ applyOp 响应里的新 revision。
  const revisionRef = useRef(canvas.revision);
  useEffect(() => {
    revisionRef.current = Math.max(revisionRef.current, canvas.revision);
  }, [canvas.revision]);
  // 切会话时基线归零重新跟随（revision 是会话内计数，跨会话不可比）
  useEffect(() => {
    revisionRef.current = 0;
  }, [sessionId]);
  // 用户 op 串行队列：避免同一时刻多个 op 抢同一 revision 基线
  const opChain = useRef<Promise<unknown>>(Promise.resolve());
  // 卸载/切会话时清掉未到点的终态计时器
  useEffect(
    () => () => {
      for (const t of Object.values(clearTimers.current)) clearTimeout(t);
    },
    [],
  );

  const serverStatus = snapQ.data?.status;
  const [syncedStatus, setSyncedStatus] = useState<string | undefined>();
  if (syncedStatus !== serverStatus) {
    setSyncedStatus(serverStatus);
    setPending(serverStatus ? BUSY.has(serverStatus) : false);
  }

  const refetchSnap = snapQ.refetch;
  const refetchMsg = msgQ.refetch;
  useEffect(() => {
    if (!sessionId) return;
    const unsub = subscribeCanvas(
      sessionId,
      (e: CanvasEvent) => {
        if (e.type === "canvas_patch") {
          setCanvas((prev) => applyPatch(prev, e.payload as CanvasPatch));
          return;
        }
        if (e.type === "token_usage") {
          const p = e.payload as { cumulativeTotal?: number };
          if (typeof p.cumulativeTotal === "number") setTokens(p.cumulativeTotal);
          // 详情报表失效：弹窗开着（有 observer）才会真去重拉，关着时零成本
          void qc.invalidateQueries({
            queryKey: ["canvas-token-usage", sessionId],
          });
          return;
        }
        if (e.type === "messages_cleared") {
          // 别处（另一个标签页/客户端）清空了会话记录：同步清掉本地对话投影
          setLiveChat([]);
          qc.setQueryData(["canvas-messages", sessionId], []);
          setPending(false);
          return;
        }
        if (e.type === "media_update") {
          // 生成状态变了：重拉快照，节点 media 字段（JOIN MediaVersion）随之更新
          void qc.invalidateQueries({ queryKey: ["canvas", sessionId] });
          return;
        }
        // 其余为对话事件
        setLiveChat((prev) => [
          ...prev,
          { type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> },
        ]);
        if (e.type === "result" || e.type === "error") setPending(false);
      },
      () => {
        void refetchSnap();
        void refetchMsg();
      },
    );
    return unsub;
  }, [sessionId, qc, refetchSnap, refetchMsg]);

  const baseChat = useMemo(
    () => (msgQ.data ? buildBaseChat(msgQ.data) : emptyChat),
    [msgQ.data],
  );
  const chat = useMemo(() => foldChat(baseChat, liveChat), [baseChat, liveChat]);

  const busy = pending || chat.ask != null;
  const status = chat.ask
    ? "waiting_approval"
    : pending
      ? "running"
      : (serverStatus ?? "idle");

  // —— actions ——
  async function send(text: string, model?: string, thinkingLevel?: string) {
    if (!sessionId) return;
    setLiveChat((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text } },
    ]);
    setPending(true);
    await appendCanvasMessage(sessionId, text, model, thinkingLevel);
  }

  async function stop() {
    if (!sessionId) return;
    await stopCanvas(sessionId);
  }

  /**
   * 清空会话记录与 agent 上下文（节点/连线与 token 统计保留）。
   * 本地同时清掉 live 增量与历史缓存，避免清空后旧气泡残留。
   */
  async function clearMessages() {
    if (!sessionId || clearing) return;
    setClearing(true);
    try {
      await clearCanvasMessages(sessionId);
      setLiveChat([]);
      qc.setQueryData(["canvas-messages", sessionId], []);
      await refetchMsg();
    } finally {
      setClearing(false);
    }
  }

  /**
   * 作废当前任务计划：后端追加一条空 plan_update 标记，之后提示词注入与历史重放都跳过它，
   * 用户继续对话就不再被这份计划牵着走。本地同步隐藏面板（不等 refetch）。
   */
  async function clearPlan() {
    if (!sessionId) return;
    setLiveChat((prev) => [
      ...prev,
      { type: "plan_update", payload: { todos: [] } },
    ]);
    await clearCanvasPlan(sessionId);
    await refetchMsg();
  }

  function answerAsk(message: string) {
    if (!sessionId || !chat.ask) return;
    // langchain HITL 仅 approve/edit/reject：用 edit 把答案写进 ask_user 的 args，
    // 工具随即以答案为返回值执行，模型据此续跑（详见 canvas.agent.factory）。
    respondCanvasControl(
      sessionId,
      buildDecisions(chat.ask.actions, { kind: "answer", text: message }),
    );
    setLiveChat((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
  }

  /**
   * approve/reject 型确认（clear_canvas / generate_media_node）：approve 执行该工具，reject 跳过。
   * 一次中断可能挂着多个调用（模型并行发了 N 个 generate_media_node），这里整批表态、
   * 逐项展开成等长的 decisions —— 数量不等会被 langchain HITL 直接抛错。
   */
  function resolveControl(approve: boolean) {
    if (!sessionId || !chat.ask) return;
    respondCanvasControl(
      sessionId,
      buildDecisions(chat.ask.actions, {
        kind: approve ? "approve" : "reject",
      }),
    );
    setLiveChat((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
  }

  /**
   * 节点位置变更（LWW，空闲期）。本地已由 react-flow 更新，这里只落库。
   * 同样计入保存指示：拖完节点也要看到「保存中 → 已保存」（与内容编辑一致）。
   */
  function moveNode(nodeId: string, x: number, y: number) {
    if (!sessionId) return;
    setCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
    }));
    beginSave(nodeId);
    void moveCanvasNode(sessionId, nodeId, x, y)
      .then(() => settleSave(nodeId, "saved", SAVED_LINGER_MS))
      .catch(() => {
        void refetchSnap();
        settleSave(nodeId, "error", ERROR_LINGER_MS);
      });
  }

  /**
   * 保存状态的记账键。画布左上角的保存徽标是全局聚合的，键本身不需要对应仍然存在的节点
   * （删除后该键短暂停留在 saved 再自动清掉，正是我们想要的反馈）。
   * 带 nodeId 的 op 按 nodeId 记；连线类 op 没有 nodeId，按 op 名合成一个键
   * （同名 op 并发由 inflight 计数聚合，不会互相顶掉）。
   */
  function saveKeyOf(op: CanvasOpInput): string | null {
    switch (op.op) {
      case "update_node":
      case "remove_node":
        return op.nodeId;
      case "add_node":
      case "add_edge":
      case "remove_edge":
        return `op:${op.op}`;
      default:
        return null;
    }
  }

  /**
   * 用户结构编辑（空闲期）：带当前 revision 做乐观并发，409 重拉快照。
   * 按 saveKeyOf 记账保存状态（saving→saved/error），供画布左上角的保存徽标显示 loading。
   */
  async function applyUserOp(op: CanvasOpInput) {
    await runUserOp(op);
  }

  /** applyUserOp 的内核：多回传一个 patch，供「新建节点后立刻接线」取服务端分配的 id。 */
  async function runUserOp(op: CanvasOpInput): Promise<CanvasPatch | null> {
    if (!sessionId) return null;
    const nodeId = saveKeyOf(op);
    // 键入时已 markSaving 点亮；这里补在途计数（beginSave 内含 markSaving，幂等）
    if (nodeId) beginSave(nodeId);
    // 串行执行：排在上一个 op 之后，保证取到的 revision 基线已被前一个响应更新
    const run = opChain.current.then(async () => {
      try {
        const res = await applyCanvasOp(sessionId, op, revisionRef.current);
        revisionRef.current = res.revision; // 立即推进基线，无需等 socket patch
        if (nodeId) settleSave(nodeId, "saved", SAVED_LINGER_MS);
        return res.patch;
      } catch {
        void refetchSnap();
        if (nodeId) settleSave(nodeId, "error", ERROR_LINGER_MS);
        return null;
      }
    });
    opChain.current = run;
    return run;
  }

  /**
   * 从某个节点的端口拖到空白处后，新建一个**已经接好线**的节点。
   *
   * 分两步走而不是一个 op：add_node 的 id 由服务端分配，只有拿到返回的 patch 才知道
   * 该给谁接线。第一步失败（并发 409 等）就直接放弃，不留一个孤立的空节点。
   */
  async function addConnectedNode(input: {
    /** 拖拽起点节点。null = 不接线，就地建一个孤立节点（画布右键菜单） */
    fromId: string | null;
    /** 从出口拉出来 → 新节点在下游；从入口拉出来 → 新节点在上游 */
    direction: "downstream" | "upstream";
    type: CanvasNodeType;
    x: number;
    y: number;
    /** 新节点的初始正文（在生成节点面板里直接写提示词时用） */
    text?: string;
  }): Promise<string | null> {
    const patch = await runUserOp({
      op: "add_node",
      type: input.type,
      text: input.text,
      x: input.x,
      y: input.y,
    });
    if (!patch || patch.op !== "add_node") return null;
    const created = patch.node.id;
    if (!input.fromId) return created;
    await runUserOp({
      op: "add_edge",
      source: input.direction === "downstream" ? input.fromId : created,
      target: input.direction === "downstream" ? created : input.fromId,
    });
    return created;
  }

  /**
   * 键入即进入 loading（防抖窗口内就显示，不等请求发出——"触发就开始"）。
   * 由编辑器在 onChange 时调用；随后的真实请求沿用同一 saving 态直到落终态。
   */
  function markSaving(nodeId: string) {
    const t = clearTimers.current[nodeId];
    if (t) {
      clearTimeout(t);
      delete clearTimers.current[nodeId];
    }
    setSaveStates((prev) =>
      prev[nodeId] === "saving" ? prev : { ...prev, [nodeId]: "saving" },
    );
  }

  /** 请求发起：在途计数 +1 并置 saving（内容编辑与位置移动共用）。 */
  function beginSave(nodeId: string) {
    inflight.current[nodeId] = (inflight.current[nodeId] ?? 0) + 1;
    markSaving(nodeId);
  }

  /** 撤销 loading：内容改回原值、最终没有 op 要发时调用（有在途请求则保持 saving）。 */
  function cancelSaving(nodeId: string) {
    if ((inflight.current[nodeId] ?? 0) > 0) return;
    setSaveStates((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  }

  /**
   * 重发一次生成（节点上「Retry」用）：同一个 generation 叠一个新版本，
   * 提示词与参考图沿用上一版（后端 MediaService.regenerate 的缺省行为）——
   * 失败重试要的就是"照原样再来一次"，不夹带上游此刻可能已经变了的内容。
   *
   * 状态不必手动改：新版本落库即推 media_update，socket 收到后重拉快照，
   * 节点的 mediaStatus 会自己走到 queued → generating → done/failed。
   */
  function retryMedia(generationId: string) {
    void regenerateMedia(generationId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["canvas", sessionId] });
      })
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : "Retry failed");
      });
  }

  /**
   * 「加入对话」：把选中的节点圈给 agent（传空数组 = 取消圈定）。
   * 会话级持续生效，服务端存在 CanvasSession.focusNodeIds 上，注入上下文时据此裁剪。
   * 成功后重拉快照，画布上的圈定标记与输入框上的提示都跟着刷新。
   */
  function setFocus(nodeIds: string[]) {
    if (!sessionId) return;
    void setCanvasFocus(sessionId, nodeIds)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["canvas", sessionId] });
      })
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : "Could not update focus");
      });
  }

  /** 保存结账：仅当该节点无其他在途请求时落终态，并在 linger 后自动清除状态。 */
  function settleSave(nodeId: string, state: SaveState, linger: number) {
    inflight.current[nodeId] = Math.max((inflight.current[nodeId] ?? 1) - 1, 0);
    if (inflight.current[nodeId] > 0) return; // 还有后续编辑在途 → 保持 saving
    setSaveStates((prev) => ({ ...prev, [nodeId]: state }));
    clearTimers.current[nodeId] = setTimeout(() => {
      delete clearTimers.current[nodeId];
      setSaveStates((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }, linger);
  }

  return {
    canvas,
    chat,
    tokens,
    /** 画布标题（快照未落地时为 null），顶部 header 展示用 */
    title: snapQ.data?.title ?? null,
    status,
    busy,
    readOnly: busy,
    /** 会话当前 agent 模型（用于初始化输入框的模型切换器）；未设时为 null。 */
    model: snapQ.data?.model ?? null,
    thinkingLevel: snapQ.data?.thinkingLevel ?? null,
    isLoading: !!sessionId && (snapQ.isLoading || msgQ.isLoading),
    /** update_node 保存状态（nodeId → saving/saved/error），驱动画布左上角的保存指示 */
    saveStates,
    /** 键入即亮 loading（防抖窗口内也显示）；内容回退无 op 可发时用 cancelSaving 撤销 */
    markSaving,
    cancelSaving,
    send,
    stop,
    /** 清空会话记录与 agent 上下文（节点/连线与 token 统计保留） */
    clearMessages,
    clearing,
    /** 作废当前任务计划（计划面板上的 ×） */
    clearPlan,
    answerAsk,
    resolveControl,
    moveNode,
    applyUserOp,
    /** 从端口拖到空白处新建一个已接好线的节点 */
    addConnectedNode,
    /** 重发一次失败的生成（节点卡片上的 Retry） */
    retryMedia,
    /** 「加入对话」圈定的节点 id（空 = 关注整块画布） */
    focusNodeIds: snapQ.data?.focusNodeIds ?? EMPTY_FOCUS,
    setFocus,
  };
}
