"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  appendMessage,
  createConversation,
  listConversations,
} from "@/lib/api";

import { ChatThread } from "./chat-thread";
import { ConversationSidebar, SidebarContent } from "./conversation-sidebar";
import { DetailPanel } from "./detail-panel";
import { useConversation } from "../_hooks/use-conversation";
import { useIsDesktop } from "../_hooks/use-is-desktop";
import { useModelPreference } from "../_hooks/use-model-preference";
import { useTheme } from "../_hooks/use-theme";
import type { ThreadItem } from "../_lib/thread";

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
  const userEmail = (session?.user?.email as string | undefined) ?? "用户";

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [manualPanel, setManualPanel] = useState<boolean | null>(null);
  const [activeDetailId, setActiveDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // 回答模型（前端可切换），发消息时随 create/append 带给后端；选择缓存到 localStorage（刷新保留）
  const [model, setModel] = useModelPreference();

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

  const thread = useConversation(conversationId);

  const createMut = useMutation({
    mutationFn: (text: string) => createConversation(text, model),
    onSuccess: ({ conversationId: newId }) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/agent/${newId}`); // 跳到新会话路由，URL 持有 id，刷新可恢复
    },
  });
  const appendMut = useMutation({
    mutationFn: (text: string) =>
      appendMessage(conversationId as string, text, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const busy = thread.busy || createMut.isPending;

  function handleSend(text: string) {
    if (!conversationId) {
      createMut.mutate(text);
    } else {
      thread.pushUserMessage(text);
      appendMut.mutate(text);
    }
  }

  function selectConversation(id: string) {
    setSidebarOpen(false);
    router.push(`/agent/${id}`);
  }

  function newChat() {
    setSidebarOpen(false);
    router.push("/agent");
  }

  function openDetail(id: string) {
    setActiveDetailId(id);
    setManualPanel(true);
  }

  const panelOpen = manualPanel ?? isDesktop;

  function togglePanel() {
    if (!panelOpen) {
      if (!activeDetailId) {
        const lastTool = [...thread.items]
          .reverse()
          .find((it) => it.kind === "tool");
        if (lastTool) setActiveDetailId(lastTool.id);
      }
      setManualPanel(true);
    } else {
      setManualPanel(false);
    }
  }

  const selectedTool = activeDetailId
    ? thread.items.find(
        (it): it is Extract<ThreadItem, { kind: "tool" }> =>
          it.kind === "tool" && it.id === activeDetailId,
      )
    : undefined;

  const activeConv = conversations.find((c) => c.id === conversationId);
  const title = conversationId ? (activeConv?.goal ?? "对话") : "新对话";

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
    userEmail,
    // redirect:false + 客户端跳转，按当前域名回 /login（避免 next-auth 按写死的 AUTH_URL 跳隧道）
    onSignOut: async () => {
      await signOut({ redirect: false });
      window.location.href = "/login";
    },
    theme,
    onCycleTheme: cycle,
  };

  return (
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
          <SheetTitle className="sr-only">会话列表</SheetTitle>
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
        activeDetailId={panelOpen ? activeDetailId : null}
        onOpenDetail={openDetail}
        onDecide={thread.respondApproval}
        onSend={handleSend}
        model={model}
        onModelChange={setModel}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        onOpenSidebar={() => setSidebarOpen(true)}
      />

      {panelOpen && selectedTool && (
        <DetailPanel tool={selectedTool} onClose={() => setManualPanel(false)} />
      )}
    </div>
  );
}
