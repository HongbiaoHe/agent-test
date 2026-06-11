"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { getConversation } from "@/lib/api";
import { respondControl, subscribeConversation } from "@/lib/socket";

import {
  buildBaseState,
  type Decision,
  emptyState,
  foldLive,
  type NormalizedEvent,
} from "../_lib/thread";

/**
 * 单个会话的对话区状态：
 * - 历史 ← GET /conversations/:id（基底，含 goal 首气泡）
 * - 实时 ← socket conversation:subscribe（订阅之后的增量事件）
 * 两段折叠进同一个 reducer。提供乐观追加与审批 4 决策。
 */
export function useConversation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<NormalizedEvent[]>([]);
  // 乐观 in-flight：创建/追加后置 true，收到 result/error 置 false（控制发送禁用与状态徽标）
  const [pending, setPending] = useState(false);

  const query = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversation(conversationId as string),
    enabled: !!conversationId,
    // 选中时取一次新鲜历史作基底；不静默 refetch，否则会和实时增量重复渲染。
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const serverStatus = query.data?.status;

  // —— 渲染期 state 校正（React 官方 "调整 state 而非用 effect" 模式）——
  // 1) 清空实时增量：切换会话、或基底历史被重新拉取（含重连对齐）时。
  //    liveEvents 只承载「基底快照之后」的新增事件，refetch 后必须重置以免与新基底重复。
  const resetKey = `${conversationId ?? ""}:${query.dataUpdatedAt}`;
  const [trackedKey, setTrackedKey] = useState(resetKey);
  if (trackedKey !== resetKey) {
    setTrackedKey(resetKey);
    setLiveEvents([]);
  }
  // 2) 服务端状态变化：据此初始化 in-flight（仅在 status 真正变化时触发一次）
  const [syncedStatus, setSyncedStatus] = useState(serverStatus);
  if (syncedStatus !== serverStatus) {
    setSyncedStatus(serverStatus);
    setPending(serverStatus === "running" || serverStatus === "queued");
  }

  // 订阅实时事件（effect 体内不 setState，只在 socket 回调里更新）
  const refetch = query.refetch; // React Query 的 refetch 引用稳定
  useEffect(() => {
    if (!conversationId) return;
    const unsub = subscribeConversation(
      conversationId,
      (e) => {
        // media_update 不进 thread reducer（卡片状态一律从 media query 读，设计 §前端职责）：
        // 只做一件事——invalidate media query，触发卡片重新拉最新版本状态。
        if (e.type === "media_update") {
          void queryClient.invalidateQueries({
            queryKey: ["conversation-media", conversationId],
          });
          return;
        }
        setLiveEvents((prev) => [
          ...prev,
          { type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> },
        ]);
        if (e.type === "result" || e.type === "error") setPending(false);
      },
      // 重连：回拉历史对齐断线期间漏掉的事件（result 等已持久化），liveEvents 随 dataUpdatedAt 重置
      () => void refetch(),
    );
    return unsub;
  }, [conversationId, refetch, queryClient]);

  const base = useMemo(
    () => (conversationId && query.data ? buildBaseState(query.data) : emptyState),
    [conversationId, query.data],
  );

  const derived = useMemo(() => foldLive(base, liveEvents), [base, liveEvents]);

  /** 追加一轮：乐观插入用户气泡（用户消息不走 socket，故本地补一条）。 */
  function pushUserMessage(text: string) {
    setLiveEvents((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text } },
    ]);
    setPending(true);
  }

  /** 审批决策（approve/reject/edit/respond），decisions 顺序对应 actionRequests。 */
  function respondApproval(decision: Decision) {
    const approval = derived.approval;
    if (!approval || !conversationId) return;
    let decisions: unknown[];
    if (decision === "edit") {
      decisions = approval.actionRequests.map((a) => {
        const input = window.prompt(
          `Edit arguments for ${a.name} (JSON):`,
          JSON.stringify(a.args),
        );
        if (input === null) return { type: "reject" };
        try {
          return { type: "edit", editedAction: { name: a.name, args: JSON.parse(input) } };
        } catch {
          return { type: "reject" };
        }
      });
    } else if (decision === "respond") {
      const input = window.prompt("Reply (returned to the agent as the tool result):") ?? "";
      decisions = approval.actionRequests.map(() => ({ type: "respond", message: input }));
    } else {
      decisions = approval.actionRequests.map(() => ({ type: decision }));
    }
    respondControl(conversationId, decisions);
    // 乐观清掉审批卡片并恢复运行态，后续 resume 事件继续流入
    setLiveEvents((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
  }

  const status = derived.approval
    ? "waiting_approval"
    : pending
      ? "running"
      : derived.status;

  return {
    items: derived.items,
    approval: derived.approval,
    status,
    busy: pending || derived.approval != null,
    isLoading: !!conversationId && query.isLoading,
    pushUserMessage,
    markRunning: () => setPending(true),
    respondApproval,
  };
}
