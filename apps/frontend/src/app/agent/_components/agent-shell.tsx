"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  GENERAL_MODE_QUERY_KEY,
  MODES_QUERY_KEY,
} from "@/app/settings/modes/_components/mode-list";
import {
  appendMessage,
  type ConversationListItem,
  createEmptyConversation,
  deleteConversation,
  getGeneralMode,
  listConversations,
  listModes,
  type MessageAttachment,
  renameConversation,
  setConversationMode,
  setConversationPinned,
  stopConversation,
} from "@/lib/api";
import { asThinkingLevel, supportsThinkingLevel } from "@/lib/thinking-level";

import { ChatThread } from "./chat-thread";
import { ConversationSidebar, SidebarContent } from "./conversation-sidebar";
import { DetailPanel } from "./detail-panel";
import {
  type PreviewTarget,
  SitePreviewContext,
  SitePreviewDialog,
} from "./site-preview";
import { useConversation } from "../_hooks/use-conversation";
import { conversationTitle } from "../_lib/conversation-title";
import { useIsDesktop } from "../_hooks/use-is-desktop";
import { useModePreference } from "../_hooks/use-mode-preference";
import { useModelPreference } from "../_hooks/use-model-preference";
import { useThinkingPreference } from "../_hooks/use-thinking-preference";
import { useTheme } from "../_hooks/use-theme";
import { MODEL_OPTIONS } from "../_lib/models";
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
  // 模式：最近用过的 id 缓存在 localStorage，新建会话时带上；已有会话的模式以服务端为准
  const [preferredModeId, setPreferredModeId] = useModePreference();
  const modesQuery = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });
  const modes = modesQuery.data ?? [];
  // 通用模式设置（默认模型 / 档位）：偏好为通用模式时新建会话据此回填。
  // 这里只负责提前预取、让缓存热着；新建时由 createMut 里的 ensureQueryData 取用
  useQuery({ queryKey: GENERAL_MODE_QUERY_KEY, queryFn: getGeneralMode });

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

  // 先创建空会话（idle）再进入：成功后跳 /agent/[id]，首条消息走 appendMessage。
  // 带上最近用的模式（已删除的按通用模式）；模式（或通用模式设置）有默认模型 / 思考深度时**只在这里**
  // 回填偏好并随请求带上，切换已有会话的模式不动模型。
  const createMut = useMutation({
    mutationFn: async () => {
      // 点得比查询返回快时，用渲染时的 modes / generalQuery.data 会拿到空值：偏好的模式被当成已删除、
      // 通用模式的默认模型也漏掉。这里先确保两份数据就绪（有缓存直接用，没有就当场取）。
      const [modeList, general] = await Promise.all([
        qc.ensureQueryData({ queryKey: MODES_QUERY_KEY, queryFn: listModes }),
        qc.ensureQueryData({ queryKey: GENERAL_MODE_QUERY_KEY, queryFn: getGeneralMode }),
      ]);
      const mode = modeList.find((m) => m.id === preferredModeId) ?? null;
      const defaults = mode ?? general;
      let nextModel = model;
      let nextLevel = thinkingLevel;
      if (
        defaults?.defaultModel &&
        MODEL_OPTIONS.some((m) => m.value === defaults.defaultModel)
      ) {
        nextModel = defaults.defaultModel;
        setModel(nextModel);
      }
      const level = asThinkingLevel(defaults?.defaultThinkingLevel);
      if (defaults?.defaultModel && level && supportsThinkingLevel(nextModel, level)) {
        nextLevel = level;
        setThinkingLevel(level);
      }
      return createEmptyConversation(nextModel, nextLevel, mode?.id ?? null);
    },
    onSuccess: ({ conversationId: newId }) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/agent/${newId}`); // 跳到新会话路由，URL 持有 id，刷新可恢复
    },
  });
  const appendMut = useMutation({
    mutationFn: ({
      text,
      attachments,
    }: {
      text: string;
      attachments: MessageAttachment[];
    }) =>
      appendMessage(
        conversationId as string,
        text,
        model,
        thinkingLevel,
        attachments.map((a) => a.versionId),
      ),
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

  // 切换已有会话的模式（空闲时；运行中按钮已禁用，后端也会 409）。成功后重拉会话拿新 modeId，并记为偏好
  const modeMut = useMutation({
    mutationFn: ({ id, modeId }: { id: string; modeId: string | null }) =>
      setConversationMode(id, modeId),
    onSuccess: (_r, { id, modeId }) => {
      setPreferredModeId(modeId);
      void qc.invalidateQueries({ queryKey: ["conversation", id] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const pinMut = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      setConversationPinned(id, pinned),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
  // 乐观更新：侧栏/顶栏立刻显示新名字，不等 refetch；失败时 onSettled 的重拉会还原
  const renameMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameConversation(id, title),
    onMutate: ({ id, title }) => {
      qc.setQueryData<ConversationListItem[]>(["conversations"], (prev) =>
        prev?.map((c) => (c.id === id ? { ...c, title: title.trim() || null } : c)),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
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
  // 当前会话的模式对象（null = 通用模式 / 模式已删除）：命令面板按它的技能集过滤
  const activeMode = thread.modeId ? (modes.find((m) => m.id === thread.modeId) ?? null) : null;
  // 运行已结束 → 复位（render-time reset，同 trackedId 模式，避免 effect 里 setState）
  if (stopRequested && !busy) {
    setStopRequested(false);
  }

  function handleStop() {
    if (!conversationId || stopRequested) return;
    setStopRequested(true);
    stopMut.mutate();
  }

  function handleSend(text: string, attachments: MessageAttachment[]) {
    if (!conversationId) return; // 新会话页只有引导按钮，没有输入框
    thread.pushUserMessage(text, attachments);
    appendMut.mutate({ text, attachments });
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
  // 重命名的标题优先；空会话（idle，goal 尚未回填）与新会话页统一显示 "New conversation"
  const title =
    conversationId && activeConv ? conversationTitle(activeConv) : "New conversation";

  // 搜索同时匹配自定义标题与首条消息：改过名的会话用原话也能搜到
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? conversations.filter((c) =>
        [c.title ?? "", c.goal].some((s) => s.toLowerCase().includes(needle)),
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
    onRename: (id: string, title: string) => renameMut.mutate({ id, title }),
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
          turnStartedAt={thread.turnStartedAt}
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
          mode={activeMode}
          onModeChange={(modeId) =>
            conversationId && modeMut.mutate({ id: conversationId, modeId })
          }
          modeSwitching={modeMut.isPending}
          model={model}
          onModelChange={setModel}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={setThinkingLevel}
          onOpenSidebar={() => setSidebarOpen(true)}
          tokens={thread.tokens}
        />

        {panelOpen && selectedTool && (
          <DetailPanel tool={selectedTool} onClose={() => setManualPanel(false)} />
        )}
      </div>
      <SitePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </SitePreviewContext>
  );
}
