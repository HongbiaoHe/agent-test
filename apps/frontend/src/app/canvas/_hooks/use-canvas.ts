"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  appendCanvasMessage,
  applyCanvasOp,
  clearCanvasMessages,
  getCanvasMessages,
  getCanvasSnapshot,
  moveCanvasNode,
  stopCanvas,
  type CanvasOpInput,
} from "@/lib/api";
import {
  respondCanvasControl,
  subscribeCanvas,
  type CanvasEvent,
} from "@/lib/socket";

import { applyPatch, type CanvasPatch, type CanvasState } from "../_lib/canvas-state";
import {
  buildBaseChat,
  emptyChat,
  foldChat,
  type ChatEvent,
} from "../_lib/chat";

const EMPTY_CANVAS: CanvasState = { nodes: [], edges: [], revision: 0 };
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

  function answerAsk(message: string) {
    if (!sessionId || !chat.ask) return;
    // langchain HITL 仅 approve/edit/reject：用 edit 把答案写进 ask_user 的 args，
    // 工具随即以答案为返回值执行，模型据此续跑（详见 canvas.agent.factory）。
    respondCanvasControl(sessionId, [
      { type: "edit", editedAction: { name: "ask_user", args: { question: message } } },
    ]);
    setLiveChat((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
  }

  /** approve/reject 型确认（clear_canvas / generate_media_node）：approve 执行该工具，reject 跳过。 */
  function resolveControl(approve: boolean) {
    if (!sessionId || !chat.ask) return;
    // reject 必须带明确 message 回灌模型：否则默认拒绝语义模糊，模型会误以为操作已完成
    // （出现"我拒绝删除、agent 却说已删空"的幻觉）。文案按被拒工具定制，避免跨工具误导。
    const rejectMessage =
      chat.ask.tool === "generate_media_node"
        ? "用户拒绝了本次生成，即放弃了该节点这次的生成意图。禁止重试同一节点或改用其他方式触发生成；" +
          "不要声称已生成任何内容。节点保持未生成状态；继续其他任务，或仅在需要时就下一步方向征询用户。"
        : "用户拒绝了此操作，即取消了该操作意图（例如：拒绝清空画布 = 不要删除节点）。" +
          "禁止改用其他工具去达成同一目的（不要再逐个 delete_node，也不要再次 clear_canvas）。" +
          "画布保持现状不变，不要声称已完成或已删除任何内容；停止该动作，转而询问用户或继续其他任务。";
    respondCanvasControl(sessionId, [
      approve ? { type: "approve" } : { type: "reject", message: rejectMessage },
    ]);
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
    if (!sessionId) return;
    const nodeId = saveKeyOf(op);
    // 键入时已 markSaving 点亮；这里补在途计数（beginSave 内含 markSaving，幂等）
    if (nodeId) beginSave(nodeId);
    // 串行执行：排在上一个 op 之后，保证取到的 revision 基线已被前一个响应更新
    const run = opChain.current.then(async () => {
      try {
        const res = await applyCanvasOp(sessionId, op, revisionRef.current);
        revisionRef.current = res.revision; // 立即推进基线，无需等 socket patch
        if (nodeId) settleSave(nodeId, "saved", SAVED_LINGER_MS);
      } catch {
        void refetchSnap();
        if (nodeId) settleSave(nodeId, "error", ERROR_LINGER_MS);
      }
    });
    opChain.current = run;
    await run;
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
    answerAsk,
    resolveControl,
    moveNode,
    applyUserOp,
  };
}
