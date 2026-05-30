"use client";

import { useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

import { ChatThread } from "./_components/chat-thread";
import {
  ConversationSidebar,
  SidebarContent,
} from "./_components/conversation-sidebar";
import { DetailPanel } from "./_components/detail-panel";
import {
  conversations,
  defaultDetailId,
  details,
  messages,
} from "./_data/mock";
import { useIsDesktop } from "./_hooks/use-is-desktop";
import { useTheme } from "./_hooks/use-theme";

export default function AgentChatTemplatePage() {
  const { theme, toggle } = useTheme();
  const isDesktop = useIsDesktop();

  const [activeConversationId, setActiveConversationId] = useState(
    conversations[0].id,
  );
  const [activeDetailId, setActiveDetailId] = useState<string | null>(
    defaultDetailId,
  );
  // null = 未手动操作，跟随视口（desktop 展开 / mobile 收起）
  const [manualPanel, setManualPanel] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const panelOpen = manualPanel ?? isDesktop;
  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? conversations[0];
  const detail = activeDetailId ? details[activeDetailId] : undefined;

  function selectConversation(id: string) {
    setActiveConversationId(id);
    setSidebarOpen(false);
  }

  function openDetail(id: string) {
    setActiveDetailId(id);
    setManualPanel(true);
  }

  function togglePanel() {
    if (!panelOpen) {
      setActiveDetailId((prev) => prev ?? defaultDetailId);
    }
    setManualPanel(!panelOpen);
  }

  const sidebarProps = {
    conversations,
    activeId: activeConversationId,
    onSelect: selectConversation,
    theme,
    onToggleTheme: toggle,
  };

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* desktop 常驻侧边栏 */}
      <ConversationSidebar {...sidebarProps} />

      {/* mobile 会话抽屉 */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-72 gap-0 bg-muted/30 p-0"
        >
          <SheetTitle className="sr-only">会话列表</SheetTitle>
          <SidebarContent {...sidebarProps} />
        </SheetContent>
      </Sheet>

      <ChatThread
        title={activeConversation.title}
        messages={messages}
        details={details}
        activeDetailId={panelOpen ? activeDetailId : null}
        onOpenDetail={openDetail}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        onOpenSidebar={() => setSidebarOpen(true)}
      />

      {panelOpen && detail && (
        <DetailPanel detail={detail} onClose={() => setManualPanel(false)} />
      )}
    </div>
  );
}
