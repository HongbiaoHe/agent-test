import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { agent } from "@/lib/agent-client";
import type { Conversation, MessageAttachment } from "@/lib/api";

import type { HitlDecision } from "../../../../../shared/rpc";
import { applyTaskUpdate, type BackgroundTask, bgTasksKey } from "../lib/background-tasks";
import { buildBaseState, emptyState, foldLive, type NormalizedEvent } from "../lib/thread";

const usagePayload = z.object({ cumulativeTotal: z.number() });

export const conversationKey = (id: string | null) => ["conversation", id] as const;

/**
 * 单个会话的对话区状态（桌面端版 Web _hooks/use-conversation.ts，返回同一套字段）：
 * - 历史 ← agent-host conversations.get（基底）
 * - 实时 ← MessagePort 推来的 conversation 事件（订阅之后的增量）
 * 两段折叠进 Web 同一个 thread reducer。后台任务状态写进 bg-tasks 缓存（卡片从缓存读），没有媒体 / 网页预览事件。
 */
export function useConversation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<NormalizedEvent[]>([]);
  const [pending, setPending] = useState(false);

  const query = useQuery({
    queryKey: conversationKey(conversationId),
    queryFn: async (): Promise<Conversation & { summary: Awaited<ReturnType<typeof getDetail>>["conversation"] }> => {
      const d = await getDetail(conversationId as string);
      return {
        id: d.conversation.id,
        goal: d.conversation.goal,
        title: d.conversation.title,
        status: d.conversation.status,
        messages: d.messages,
        totalTokens: d.totalTokens,
        summary: d.conversation,
      };
    },
    enabled: !!conversationId,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const serverStatus = query.data?.status;

  // 渲染期 state 校正（同 Web）：切会话 / 基底重拉时清空实时增量与 token 基底
  const resetKey = `${conversationId ?? ""}:${query.dataUpdatedAt}`;
  const [trackedKey, setTrackedKey] = useState(resetKey);
  const [tokens, setTokens] = useState(query.data?.totalTokens ?? 0);
  if (trackedKey !== resetKey) {
    setTrackedKey(resetKey);
    setLiveEvents([]);
    setTokens(query.data?.totalTokens ?? 0);
  }
  const [syncedStatus, setSyncedStatus] = useState(serverStatus);
  if (syncedStatus !== serverStatus) {
    setSyncedStatus(serverStatus);
    setPending(serverStatus === "running");
  }

  const refetch = query.refetch;
  useEffect(() => {
    if (!conversationId) return;
    return agent.subscribe((e) => {
      // agent-host 重启：回拉历史对齐（liveEvents 随 dataUpdatedAt 重置）
      if (e.kind === "reconnected") {
        void refetch();
        return;
      }
      if (e.type !== "conversation" || e.conversationId !== conversationId) return;
      const { type, payload, ts } = e.event;
      if (type === "token_usage") {
        const p = usagePayload.safeParse(payload);
        if (p.success) setTokens(p.data.cumulativeTotal);
        void queryClient.invalidateQueries({ queryKey: ["conversation-token-usage", conversationId] });
        return;
      }
      // 后台任务状态：写进任务列表缓存（卡片从缓存读），不进 thread
      if (type === "bg_task_update") {
        queryClient.setQueryData<BackgroundTask[]>(bgTasksKey(conversationId), (prev) =>
          applyTaskUpdate(prev, payload),
        );
        return;
      }
      const record = typeof payload === "object" && payload !== null ? { ...payload } : {};
      setLiveEvents((prev) => [...prev, { type, payload: record, at: ts }]);
      if (type === "result" || type === "error") setPending(false);
      // 后台任务通知唤醒了 agent：新的一轮开始了
      if (type === "task_notification") setPending(true);
      // 工具改了文件：右上角文件面板下次打开 / 展开时重新拉
      if (type === "tool_end") {
        void queryClient.invalidateQueries({ queryKey: ["sandbox-dir", conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["sandbox-file", conversationId] });
      }
    });
  }, [conversationId, refetch, queryClient]);

  const base = useMemo(
    () => (conversationId && query.data ? buildBaseState(query.data) : emptyState),
    [conversationId, query.data],
  );
  const derived = useMemo(() => foldLive(base, liveEvents), [base, liveEvents]);

  /** 乐观插入用户气泡（用户消息不经事件推送），时间先用本地 now */
  function pushUserMessage(text: string, attachments: MessageAttachment[] = []) {
    setLiveEvents((prev) => [
      ...prev,
      { type: "message", role: "user", payload: { text, attachments }, at: Date.now() },
    ]);
    setPending(true);
  }

  /** 审批决策回传：decisions 由 ApprovalPanel / QuestionPanel 组装，顺序对应 actionRequests */
  async function respondApproval(decisions: HitlDecision[]) {
    if (!derived.approval || !conversationId) return;
    setLiveEvents((prev) => [...prev, { type: "control_resolved", payload: {} }]);
    setPending(true);
    try {
      await agent.call("run.resume", { conversationId, decisions });
    } catch (e) {
      setPending(false);
      void refetch();
      throw e;
    }
  }

  const status = derived.approval ? "waiting_approval" : pending ? "running" : derived.status;

  return {
    items: derived.items,
    approval: derived.approval,
    status,
    busy: pending || derived.approval != null,
    turnStartedAt: derived.turnStartedAt,
    tokens,
    summary: query.data?.summary ?? null,
    messageCount: query.data?.messages.length ?? 0,
    isLoading: !!conversationId && query.isLoading,
    pushUserMessage,
    markRunning: () => setPending(true),
    markIdle: () => setPending(false),
    respondApproval,
  };
}

function getDetail(id: string) {
  return agent.call("conversations.get", { id });
}
