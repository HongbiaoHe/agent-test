"use client";

import { runLockFromEvent } from "@agent-test/canvas-schema";
import { useCanvasBoard, type CanvasBoardSource } from "@agent-test/canvas-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  appendCanvasMessage,
  applyCanvasOp,
  clearCanvasMessages,
  clearCanvasPlan,
  getCanvasMessages,
  generateCanvasNode,
  getCanvasSnapshot,
  mergeCanvasVideoNode,
  moveCanvasNode,
  regenerateMedia,
  setCanvasFocus,
  setCanvasMockMedia,
  stopCanvas,
  pauseCanvasMedia,
  resumeCanvasMedia,
  uploadCanvasNodeFile,
  type CanvasPatch,
  type CanvasSnapshot,
  type MessageAttachment,
} from "@/lib/api";
import {
  respondCanvasControl,
  subscribeCanvas,
  type CanvasEvent,
} from "@/lib/socket";

import { buildDecisions } from "../_lib/ask-decisions";
import {
  buildBaseChat,
  emptyChat,
  foldChat,
  type ChatEvent,
} from "../_lib/chat";

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

  // —— 画布编辑区：投影、保存状态、用户操作、运行锁（与 desktop 共用 canvas-ui 的 useCanvasBoard）——
  // useCanvasBoard 只在 canvasId 非空时调用 source（各操作开头都判了），这里的空串分支走不到
  const id = sessionId ?? "";
  const source: CanvasBoardSource = {
    applyOp: (op, baseRevision) =>
      applyCanvasOp(id, op, baseRevision),
    moveNode: (nodeId, x, y) =>
      moveCanvasNode(id, nodeId, x, y),
    generateNode: (nodeId) => generateCanvasNode(id, nodeId),
    mergeVideo: (nodeId) => mergeCanvasVideoNode(id, nodeId),
    pauseMedia: (nodeId) => pauseCanvasMedia(id, nodeId),
    resumeMedia: (nodeId) => resumeCanvasMedia(id, nodeId),
    retryMedia: (generationId) => regenerateMedia(generationId),
    uploadNodeFile: (nodeId, file, opts) =>
      uploadCanvasNodeFile(id, nodeId, file, opts),
    setFocus: (nodeIds) => setCanvasFocus(id, nodeIds),
    refresh: () => void qc.invalidateQueries({ queryKey: ["canvas", sessionId] }),
  };
  const board = useCanvasBoard({
    canvasId: sessionId,
    snapshot: snapQ.data,
    snapshotUpdatedAt: snapQ.dataUpdatedAt,
    source,
    locale: "en",
  });
  const applyBoardEvent = board.applyEvent;

  // token 累计：快照持久化总量作基底，token_usage 事件（会话级累计）覆盖
  const [tokens, setTokens] = useState(0);
  const snapKey = `${sessionId ?? ""}:${snapQ.dataUpdatedAt}`;
  const [trackedSnap, setTrackedSnap] = useState("");
  if (trackedSnap !== snapKey) {
    setTrackedSnap(snapKey);
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
          applyBoardEvent(e.payload as CanvasPatch);
          return;
        }
        if (e.type === "canvas_lock") {
          // desktop 本机 agent 拿到 / 续期 / 释放了运行锁：只改缓存快照里的 runLock。
          // updatedAt 沿用原值——dataUpdatedAt 一变，上面的快照同步块会按这份（可能较旧的）快照
          // 重铺画布，冲掉之后到达的 patch
          const runLock = runLockFromEvent(e.payload);
          if (runLock === undefined) return;
          const key = ["canvas", sessionId];
          qc.setQueryData<CanvasSnapshot>(
            key,
            (prev) => (prev ? { ...prev, runLock } : prev),
            { updatedAt: qc.getQueryState(key)?.dataUpdatedAt },
          );
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
  }, [sessionId, qc, refetchSnap, refetchMsg, applyBoardEvent]);

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

  // desktop 本机 agent 持有的运行锁（快照基底 + canvas_lock 事件更新；到点自动失效，见 useCanvasBoard）
  const desktopLock = board.activeLock;

  // —— actions ——
  async function send(
    text: string,
    model?: string,
    thinkingLevel?: string,
    approvalMode?: string,
    attachments: MessageAttachment[] = [],
  ) {
    if (!sessionId) return;
    setLiveChat((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text, attachments } },
    ]);
    setPending(true);
    await appendCanvasMessage(
      sessionId,
      text,
      model,
      thinkingLevel,
      approvalMode,
      attachments.map((a) => a.versionId),
    );
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

  // 测试模式开关的乐观值：不改 react-query 里的快照（那会让画布按旧快照重铺、冲掉之后到达的 patch），
  // 本地先显示，等快照里的值追上来再交还（render 期同步，规避 effect-setState）
  const [mockPending, setMockPending] = useState<boolean | null>(null);
  const serverMock = snapQ.data?.mockMedia ?? false;
  if (mockPending !== null && serverMock === mockPending) setMockPending(null);

  /** 切换测试模式：立即保存到画布上，之后触发的生成按新值走（已在跑的不受影响）。 */
  function setMockMedia(on: boolean) {
    if (!sessionId) return;
    setMockPending(on);
    void setCanvasMockMedia(sessionId, on)
      .then(() => qc.invalidateQueries({ queryKey: ["canvas", sessionId] }))
      .catch((e: unknown) => {
        setMockPending(null);
        toast.error(e instanceof Error ? e.message : "Could not switch Mock mode");
      });
  }

  return {
    canvas: board.canvas,
    chat,
    tokens,
    /** 画布标题（快照未落地时为 null），顶部 header 展示用 */
    title: snapQ.data?.title ?? null,
    status,
    busy,
    /**
     * 结构只读：服务端 agent 在跑（busy），或 desktop 本机 agent 持有有效的运行锁——与后端
     * canvas-schema 的 isCanvasBusy 同一口径（用户只能拖位置，结构编辑会被服务端拒）
     */
    readOnly: busy || desktopLock !== null,
    /** desktop 本机 agent 正持有的运行锁（已过期的不算）；null = 没有 */
    desktopLock,
    /** 会话当前 agent 模型（用于初始化输入框的模型切换器）；未设时为 null。 */
    model: snapQ.data?.model ?? null,
    thinkingLevel: snapQ.data?.thinkingLevel ?? null,
    isLoading: !!sessionId && (snapQ.isLoading || msgQ.isLoading),
    /** update_node 保存状态（nodeId → saving/saved/error），驱动画布左上角的保存指示 */
    saveStates: board.saveStates,
    /** 键入即亮 loading（防抖窗口内也显示）；内容回退无 op 可发时用 cancelSaving 撤销 */
    markSaving: board.markSaving,
    cancelSaving: board.cancelSaving,
    send,
    stop,
    /** 清空会话记录与 agent 上下文（节点/连线与 token 统计保留） */
    clearMessages,
    clearing,
    /** 作废当前任务计划（计划面板上的 ×） */
    clearPlan,
    answerAsk,
    resolveControl,
    moveNode: board.moveNode,
    applyUserOp: board.applyOp,
    /** 从端口拖到空白处新建一个已接好线的节点 */
    addConnectedNode: board.addNode,
    /** 重发一次失败的生成（节点卡片上的 Retry） */
    retryMedia: board.retryMedia,
    /** 用选定的模型生成一次（生成节点面板上的 Generate） */
    generateNode: board.generateNode,
    /** 触发视频拼接（video_concat 卡片上的 Merge） */
    mergeVideo: board.mergeVideo,
    /** 暂停 / 继续生成（顶栏的全部暂停 / 继续、卡片上的单节点暂停 / 继续） */
    pauseMedia: board.pauseMedia,
    resumeMedia: board.resumeMedia,
    /** 给上传节点传文件（卡片上的选择 / 拖入） */
    uploadNodeFile: board.uploadNodeFile,
    /** 敏感操作审批模式（会话级，后端已归一化） */
    approvalMode: snapQ.data?.approvalMode ?? "review",
    /** 「加入对话」圈定的节点 id（空 = 关注整块画布） */
    focusNodeIds: board.focusNodeIds,
    setFocus: board.setFocus,
    /** 测试模式（Mock）：当前开关（含乐观值）、环境是否允许、切换 */
    mockMedia: mockPending ?? serverMock,
    mockMediaAvailable: snapQ.data?.mockMediaAvailable ?? false,
    setMockMedia,
  };
}
