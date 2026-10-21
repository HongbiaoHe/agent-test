"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import {
  getConversation,
  type MediaGeneration,
  type MessageAttachment,
} from "@/lib/api";
import { respondControl, subscribeConversation } from "@/lib/socket";

import {
  applyMediaUpdate,
  buildBaseState,
  emptyState,
  foldLive,
  type NormalizedEvent,
  parsePreviewResult,
  type PreviewSpec,
} from "../_lib/thread";

/**
 * 单个会话的对话区状态：
 * - 历史 ← GET /conversations/:id（基底，含 goal 首气泡）
 * - 实时 ← socket conversation:subscribe（订阅之后的增量事件）
 * 两段折叠进同一个 reducer。提供乐观追加与审批 4 决策。
 *
 * onPreview：agent 调 preview_page 成功时**实时**回调（自动弹出预览）。只看 socket 实时事件，
 * 历史回放与重连对齐不触发——打开旧会话不会把历史里的预览一个个弹出来。
 */
export function useConversation(
  conversationId: string | null,
  options?: { onPreview?: (spec: PreviewSpec) => void },
) {
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

  // effect event：拿最新的 onPreview，又不把它放进订阅 effect 的依赖（否则每次渲染都重订阅）
  const firePreview = useEffectEvent((spec: PreviewSpec) => {
    options?.onPreview?.(spec);
  });

  // 订阅实时事件（effect 体内不 setState，只在 socket 回调里更新）
  const refetch = query.refetch; // React Query 的 refetch 引用稳定
  useEffect(() => {
    if (!conversationId) return;
    const unsub = subscribeConversation(
      conversationId,
      (e) => {
        // media_update 不进 thread reducer（卡片状态一律从 media query 读，设计 §前端职责）：
        // 先把事件里的状态就地写进缓存（状态变化立刻可见，不等 refetch 往返），
        // 再 invalidate 拉全量（新建的生成位、产物文件名等事件里没有的字段）。
        if (e.type === "media_update") {
          const key = ["conversation-media", conversationId];
          queryClient.setQueryData<MediaGeneration[]>(key, (prev) =>
            prev ? applyMediaUpdate(prev, e.payload) : prev,
          );
          void queryClient.invalidateQueries({ queryKey: key });
          return;
        }
        setLiveEvents((prev) => [
          ...prev,
          { type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> },
        ]);
        if (e.type === "result" || e.type === "error") setPending(false);
        if (e.type === "tool_end") {
          const payload = (e.payload ?? {}) as Record<string, unknown>;
          const spec =
            payload.name === "preview_page"
              ? parsePreviewResult(payload.content)
              : null;
          if (spec) firePreview(spec);
        }
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
  function pushUserMessage(text: string, attachments: MessageAttachment[] = []) {
    setLiveEvents((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text, attachments } },
    ]);
    setPending(true);
  }

  /** 审批决策回传：decisions 由 ApprovalPanel 组装，顺序对应 actionRequests。 */
  function respondApproval(decisions: unknown[]) {
    if (!derived.approval || !conversationId) return;
    respondControl(conversationId, decisions);
    // 乐观清掉审批面板并恢复运行态，后续 resume 事件继续流入
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
