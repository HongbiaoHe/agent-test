"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  appendCanvasMessage,
  applyCanvasOp,
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
  const [tokens, setTokens] = useState(0);

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
  async function send(text: string, model?: string) {
    if (!sessionId) return;
    setLiveChat((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text } },
    ]);
    setPending(true);
    await appendCanvasMessage(sessionId, text, model);
  }

  async function stop() {
    if (!sessionId) return;
    await stopCanvas(sessionId);
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

  /** approve/reject 型确认（如 clear_canvas）：approve 执行该工具，reject 跳过。 */
  function resolveControl(approve: boolean) {
    if (!sessionId || !chat.ask) return;
    // reject 必须带明确 message 回灌模型：否则默认拒绝语义模糊，模型会误以为操作已完成
    // （出现"我拒绝删除、agent 却说已删空"的幻觉）。approve 则直接执行该工具。
    respondCanvasControl(sessionId, [
      approve
        ? { type: "approve" }
        : {
            type: "reject",
            message:
              "用户拒绝了此操作，即取消了该操作意图（例如：拒绝清空画布 = 不要删除节点）。" +
              "禁止改用其他工具去达成同一目的（不要再逐个 delete_node，也不要再次 clear_canvas）。" +
              "画布保持现状不变，不要声称已完成或已删除任何内容；停止该动作，转而询问用户或继续其他任务。",
          },
    ]);
    setLiveChat((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
  }

  /** 节点位置变更（LWW，空闲期）。本地已由 react-flow 更新，这里只落库。 */
  function moveNode(nodeId: string, x: number, y: number) {
    if (!sessionId) return;
    setCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
    }));
    void moveCanvasNode(sessionId, nodeId, x, y).catch(() => void refetchSnap());
  }

  /** 用户结构编辑（空闲期）：带当前 revision 做乐观并发，409 重拉快照。 */
  async function applyUserOp(op: CanvasOpInput) {
    if (!sessionId) return;
    try {
      await applyCanvasOp(sessionId, op, canvas.revision);
    } catch {
      void refetchSnap();
    }
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
    isLoading: !!sessionId && (snapQ.isLoading || msgQ.isLoading),
    send,
    stop,
    answerAsk,
    resolveControl,
    moveNode,
    applyUserOp,
  };
}
