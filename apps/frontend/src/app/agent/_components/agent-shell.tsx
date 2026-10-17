"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  appendMessage,
  createEmptyConversation,
  deleteConversation,
  listConversations,
  setConversationPinned,
  stopConversation,
} from "@/lib/api";

import { ChatThread } from "./chat-thread";
import { ConversationSidebar, SidebarContent } from "./conversation-sidebar";
import { DetailPanel } from "./detail-panel";
import {
  type PreviewTarget,
  SitePreviewContext,
  SitePreviewDialog,
} from "./site-preview";
import { useConversation } from "../_hooks/use-conversation";
import { useIsDesktop } from "../_hooks/use-is-desktop";
import { useModelPreference } from "../_hooks/use-model-preference";
import { useThinkingPreference } from "../_hooks/use-thinking-preference";
import { useTheme } from "../_hooks/use-theme";
import type { PreviewSpec, ThreadItem } from "../_lib/thread";

/**
 * 会话外壳：会话由 URL（/agent 或 /agent/[id]）驱动，conversationId 作为入参。
 * 切换会话走 router.push 改 URL；[id1]→[id2] 是同一路由段、本组件不重挂载，平滑切换。
 */
export function AgentShell({ conversationId }: { conversationId: string | null }) {
  const router = useRouter();
  const { theme, cycle } = useTheme();
  const isDesktop = useIsDesktop();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const userEmail = (session?.user?.email as string | undefined) ?? "User";

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [manualPanel, setManualPanel] = useState<boolean | null>(null);
  const [activeDetailId, setActiveDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // 回答模型（前端可切换），发消息时随 create/append 带给后端；选择缓存到 localStorage（刷新保留）
  const [model, setModel] = useModelPreference();
  // 思考深度：同样随 create/append 带给后端；当前模型不支持的档位已在 hook 里回落 auto
  const [thinkingLevel, setThinkingLevel] = useThinkingPreference(model);

  // 切换会话（含 [id1]→[id2] 不重挂载的情况）时清掉详情面板选择
  const [trackedId, setTrackedId] = useState(conversationId);
  if (trackedId !== conversationId) {
    setTrackedId(conversationId);
    setActiveDetailId(null);
  }

  const convQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: listConversations,
  });
  const conversations = convQuery.data ?? [];

  // 网页预览弹窗（全局一个）：agent 主动触发、消息流卡片、沙箱文件面板三个入口共用
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const openPreview = useCallback((spec: PreviewSpec) => {
    setPreview({ ...spec, nonce: Date.now() });
  }, []);

  const thread = useConversation(conversationId, { onPreview: openPreview });

  // 先创建空会话（idle）再进入：成功后跳 /agent/[id]，首条消息走 appendMessage
  const createMut = useMutation({
    mutationFn: () => createEmptyConversation(model, thinkingLevel),
    onSuccess: ({ conversationId: newId }) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/agent/${newId}`); // 跳到新会话路由，URL 持有 id，刷新可恢复
    },
  });
  const appendMut = useMutation({
    mutationFn: (text: string) =>
      appendMessage(conversationId as string, text, model, thinkingLevel),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
  // 主动停止：busy 收尾由后端 result{status:'stopped'} 事件驱动（SSE），这里只发指令。
  // stopRequested 让按钮的 loading 从点击持续到运行真正结束（HTTP 返回 ≠ 收尾完成）；
  // 失败则复位允许重试（全局 MutationCache 已 toast 错误）。
  const [stopRequested, setStopRequested] = useState(false);
  const stopMut = useMutation({
    mutationFn: () => stopConversation(conversationId as string),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: () => setStopRequested(false),
  });

  const pinMut = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      setConversationPinned(id, pinned),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
  // 删掉的是当前打开的会话 → 回到新会话页（旧 URL 已经 404）
  const deleteMut = useMutation({
    mutationFn: deleteConversation,
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      if (id === conversationId) router.push("/agent");
    },
  });

  const busy = thread.busy || createMut.isPending;
  // 运行已结束 → 复位（render-time reset，同 trackedId 模式，避免 effect 里 setState）
  if (stopRequested && !busy) {
    setStopRequested(false);
  }

  function handleStop() {
    if (!conversationId || stopRequested) return;
    setStopRequested(true);
    stopMut.mutate();
  }

  function handleSend(text: string) {
    if (!conversationId) return; // 新会话页只有引导按钮，没有输入框
    thread.pushUserMessage(text);
    appendMut.mutate(text);
  }

  function selectConversation(id: string) {
    setSidebarOpen(false);
    router.push(`/agent/${id}`);
  }

  function newChat() {
    if (createMut.isPending) return; // 防重复点击
    setSidebarOpen(false);
    createMut.mutate();
  }

  function openDetail(id: string) {
    setActiveDetailId(id);
    setManualPanel(true);
  }

  const panelOpen = manualPanel ?? isDesktop;

  const selectedTool = activeDetailId
    ? thread.items.find(
        (it): it is Extract<ThreadItem, { kind: "tool" }> =>
          it.kind === "tool" && it.id === activeDetailId,
      )
    : undefined;

  const activeConv = conversations.find((c) => c.id === conversationId);
  // 空会话（idle，goal 尚未回填）与新会话页统一显示 "New conversation"
  const title =
    conversationId && activeConv?.goal.trim()
      ? activeConv.goal
      : "New conversation";

  const filtered = search.trim()
    ? conversations.filter((c) =>
        c.goal.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : conversations;

  const sidebarProps = {
    conversations: filtered,
    isLoading: convQuery.isLoading,
    activeId: conversationId,
    query: search,
    onQueryChange: setSearch,
    onSelect: selectConversation,
    onNewChat: newChat,
    onTogglePin: (id: string, pinned: boolean) => pinMut.mutate({ id, pinned }),
    onDelete: (id: string) => deleteMut.mutate(id),
    userEmail,
    theme,
    onCycleTheme: cycle,
  };

  return (
    <SitePreviewContext value={openPreview}>
      <div className="flex h-full w-full overflow-clip">
        {/* desktop 常驻侧边栏 */}
        <ConversationSidebar {...sidebarProps} />

        {/* mobile 会话抽屉 */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-72 gap-0 bg-background p-0"
          >
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <SidebarContent {...sidebarProps} />
          </SheetContent>
        </Sheet>

        <ChatThread
          title={title}
          conversationId={conversationId}
          items={thread.items}
          approval={thread.approval}
          busy={busy}
          isLoading={thread.isLoading}
          isNewChat={!conversationId}
          creating={createMut.isPending}
          onNewChat={newChat}
          activeDetailId={panelOpen ? activeDetailId : null}
          onOpenDetail={openDetail}
          onDecide={thread.respondApproval}
          onSend={handleSend}
          onStop={handleStop}
          stopping={stopRequested}
          model={model}
          onModelChange={setModel}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={setThinkingLevel}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        {panelOpen && selectedTool && (
          <DetailPanel tool={selectedTool} onClose={() => setManualPanel(false)} />
        )}
      </div>
      <SitePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </SitePreviewContext>
  );
}
