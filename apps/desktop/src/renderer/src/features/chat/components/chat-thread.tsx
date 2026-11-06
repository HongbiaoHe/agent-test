import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Folder,
  Loader,
  Paperclip,
  Plus,
  Slash,
  Sparkles,
  Square,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ThinkingSwitcher } from "@/components/agent/thinking-switcher";
import { TokenUsageDialog } from "@/components/agent/token-usage-dialog";
import { ATTACHMENTS_MAX } from "@/components/attachments/attachments";
import { ComposerAttachments } from "@/components/attachments/composer-attachments";
import { McpAppCard, McpReconnectCard } from "@/components/mcp";
import { Badge } from "@/components/ui/badge";
import { JumpToLatest } from "@/components/chat/jump-to-latest";
import { useChatScroll } from "@/components/chat/use-chat-scroll";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getConversationTokenUsage, type SkillKind, listCommands, listModes, MODES_QUERY_KEY } from "@/lib/api";
import { currentLocale } from "@/lib/i18n";
import type { ThinkingLevel } from "@/lib/thinking-level";
import { cn } from "@/lib/utils";

import type { WorkspacePermission } from "../../../../../shared/workspace";
import { modelDisplayName } from "../lib/models";
import type { Approval, ThreadItem } from "../lib/thread";
import { isSameDay } from "../lib/time";
import { ApprovalPanel } from "./approval-panel";
import { AskUserAnswers } from "./ask-user-answers";
import { BackgroundTaskCard, TaskNotificationRow } from "./background-task-card";
import { isAskUserApproval, QuestionPanel } from "./question-panel";
import { ChatMessage } from "./chat-message";
import { DayDivider } from "./day-divider";
import { MediaGroup } from "./media-card";
import { ModelSwitcher } from "./model-switcher";
import { ModeSwitcher } from "./mode-switcher";
import { PermissionSwitcher } from "./permission-switcher";
import { PreviewCard } from "./preview-card";
import { WorkspaceFilesButton } from "./workspace-panel";
import { TaskPlanPanel } from "./task-plan-panel";
import { ThinkingIndicator } from "./thinking-indicator";
import { type ActivityItem, ActivityGroup } from "./activity-group";
import { TurnFooter } from "./turn-footer";

/** `/` 补全面板分组顺序（Built-in 在前，与设置页一致） */
const CMD_KIND_ORDER: SkillKind[] = ["builtin", "github", "custom"];

export function ChatThread({
  title,
  conversationId,
  items,
  approval,
  busy,
  turnStartedAt,
  isLoading,
  isNewChat,
  creating,
  onNewChat,
  activeDetailId,
  onOpenDetail,
  onDecide,
  onSend,
  onStop,
  stopping,
  model,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  headerInset,
  headerTitle,
  headerTools,
  tokens,
  workspaceDir,
  permission,
  onPermissionChange,
  canChangeWorkspace,
  onChangeWorkspace,
  modeId,
  onModeChange,
}: {
  title: string;
  conversationId: string | null;
  items: ThreadItem[];
  approval: Approval | null;
  busy: boolean;
  /** 进行中这一轮的开始时间（服务端），思考指示器据此计时、刷新不归零 */
  turnStartedAt: number | null;
  isLoading: boolean;
  isNewChat: boolean;
  /** 创建空会话请求在途（引导页按钮转圈防重复点击） */
  creating: boolean;
  onNewChat: () => void;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  /** 审批决策回传：decisions 顺序对应 actionRequests（由 ApprovalPanel 组装） */
  onDecide: (decisions: unknown[]) => void;
  /** 发送：正文 + 本地附件路径（带附件时正文可为空；agent-host 复制进会话运行目录） */
  onSend: (text: string, attachments: string[]) => void;
  onStop: () => void;
  /** 停止指令请求中（HTTP 在途）：按钮转圈并禁用，防重复点击 */
  stopping: boolean;
  model: string;
  onModelChange: (model: string) => void;
  /** 思考深度（对当前模型生效的档位） */
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  /** 侧栏收起时顶栏左侧让出红绿灯与侧栏开关的位置（padding 类名） */
  headerInset?: string;
  /** 顶栏标题位（桌面端：标题 + 会话菜单）；缺省渲染纯文本标题 */
  headerTitle?: ReactNode;
  /** 顶栏右侧、token 徽标之前的工具图标（任务计划 / 网页预览） */
  headerTools?: ReactNode;
  /** 会话累计 token（顶栏徽标，点开看详情） */
  tokens: number;
  /** 会话工作区（本机目录）与权限档位（桌面端独有） */
  workspaceDir: string | null;
  permission: WorkspacePermission;
  onPermissionChange: (permission: WorkspacePermission) => void;
  /** 还没发过消息时才能换目录 */
  canChangeWorkspace: boolean;
  onChangeWorkspace: () => void;
  /** 会话模式（null = 通用）；运行中禁切 */
  modeId: string | null;
  onModeChange: (modeId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [usageOpen, setUsageOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框附件：本地文件路径，发送时由 agent-host 复制（无上传过程，选中即就绪）
  const [attachments, setAttachments] = useState<string[]>([]);
  const addAttachments = (paths: string[]) =>
    setAttachments((cur) => [...new Set([...cur, ...paths])].slice(0, ATTACHMENTS_MAX));
  const addFiles = (files: FileList) =>
    addAttachments(
      Array.from(files)
        .map((f) => window.desktop.getPathForFile(f))
        .filter(Boolean),
    );
  const [dragging, setDragging] = useState(false);
  const canSend = !busy && (draft.trim().length > 0 || attachments.length > 0);
  // 滚动编排：发送后把这条消息顶到视口顶部，回复在其下方生长而视图不动；
  // 底部留白只缩不涨；跟随底部默认关，只由「回到最新」按钮开启。
  const { contentRef, spacerRef, atLatest, armAnchor, jumpToLatest } =
    useChatScroll(items, conversationId);

  // 可用命令（/ 自动补全）
  const { data: allCommands = [] } = useQuery({
    queryKey: ["commands"],
    queryFn: listCommands,
    staleTime: 5 * 60_000,
  });
  const { data: modes = [] } = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });
  // 当前模式只列它勾选的技能（通用模式 / 模式已删 → 全列）；/skills 安装命令不是技能，始终可用
  const currentMode = modeId ? modes.find((m) => m.id === modeId) : undefined;
  const commands = currentMode
    ? allCommands.filter((c) => c.name === "skills" || currentMode.skillNames.includes(c.name))
    : allCommands;

  // 正在输入命令名（以 / 开头且还没空格）→ 弹补全
  const cmdPrefix =
    draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1) : null;
  const matches =
    cmdPrefix === null
      ? []
      : commands.filter((c) =>
          c.name.toLowerCase().startsWith(cmdPrefix.toLowerCase()),
        );
  const showCmdMenu = !busy && cmdPrefix !== null && matches.length > 0;

  // 按分类（Built-in/GitHub）分组展示；flat 为菜单从上到下的实际可选顺序（键盘导航以此为准），
  // 与渲染共用同一 groupedKinds，保证顺序一致
  const groupedKinds = CMD_KIND_ORDER.map(
    (k) => [k, matches.filter((c) => c.kind === k)] as const,
  ).filter(([, cmds]) => cmds.length > 0);
  const flat = groupedKinds.flatMap(([, cmds]) => cmds);

  // 候选项变化（输入过滤 / 菜单重新打开）时，默认高亮第一个
  const [prevPrefix, setPrevPrefix] = useState(cmdPrefix);
  if (prevPrefix !== cmdPrefix) {
    setPrevPrefix(cmdPrefix);
    setActiveIndex(0);
  }

  function submit() {
    if (!canSend) return;
    armAnchor();
    onSend(draft.trim(), attachments);
    setDraft("");
    setAttachments([]);
  }

  /** 粘贴：剪贴板里有文件（截图、复制的图片）就当附件收下，不往输入框里贴 */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || e.clipboardData.files.length === 0) return;
    e.preventDefault();
    addFiles(e.clipboardData.files);
  }

  /** 拖拽文件进输入框：只认带文件的拖拽（拖一段文字进来照常） */
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (busy || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (busy || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }

  function pickCommand(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showCmdMenu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActiveIndex((i) =>
        e.key === "ArrowDown"
          ? (i + 1) % flat.length
          : (i - 1 + flat.length) % flat.length,
      );
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 补全打开时 Enter 选中当前高亮命令并收起菜单，而不是发送半截命令
      if (showCmdMenu) pickCommand((flat[activeIndex] ?? flat[0]).name);
      else submit();
    }
  }

  // 忙碌时不显示空状态占位，让首轮的思考指示器接管
  const showEmpty = !isLoading && items.length === 0 && !busy;

  // 任务计划独立固定在输入框上方，故从消息流中剔除，避免重复渲染
  const plan = items.find(
    (it): it is Extract<ThreadItem, { kind: "plan" }> => it.kind === "plan",
  );
  const streamItems = items.filter((it) => it.kind !== "plan");

  // 把相邻的思考与工具调用收成一个活动组，交给 ActivityGroup 渲染（单项不加组头）；
  // 其余消息照常一条一条交给 ChatMessage。
  // 用户消息与上一条用户消息不在同一天时，前面插一条日期分隔线；第一条用户消息前也插，
  // 但标 first —— 是今天就不显示（全是今天的会话不出分隔线）。
  type Row =
    | { row: "msg"; item: ThreadItem }
    | { row: "activity"; id: string; items: ActivityItem[] }
    | { row: "day"; id: string; at: number; first: boolean };
  const rows: Row[] = [];
  let prevUserAt: number | null = null;
  for (const it of streamItems) {
    if (it.kind === "user" && it.at != null) {
      if (prevUserAt == null || !isSameDay(prevUserAt, it.at)) {
        rows.push({ row: "day", id: `day-${it.id}`, at: it.at, first: prevUserAt == null });
      }
      prevUserAt = it.at;
    }
    const last = rows[rows.length - 1];
    if (it.kind === "tool" || it.kind === "reasoning") {
      if (last?.row === "activity") last.items.push(it);
      else rows.push({ row: "activity", id: it.id, items: [it] });
    } else {
      rows.push({ row: "msg", item: it });
    }
  }

  // 思考指示器仅在「忙、非审批、且末项不是正在流式的气泡/调用中的工具卡」时可见——
  // 填补发送→首 token/工具前、工具完成→下段文本前、两段之间的空档；有实时内容时自动让位。
  // 整轮 busy 期间都挂载（见下方渲染），仅切显隐，使秒数跨空档连续。
  const lastItem = streamItems[streamItems.length - 1];
  const lastActive =
    (lastItem?.kind === "assistant" && lastItem.streaming) ||
    (lastItem?.kind === "reasoning" && lastItem.streaming) ||
    (lastItem?.kind === "tool" && !lastItem.done);
  const thinkingVisible = busy && !approval && !lastActive;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* 顶栏 */}
      {/* h-12：与侧栏顶部（红绿灯那一行）同高，收起侧栏后标题和开关在一条线上 */}
      <header
        className={cn(
          "app-drag flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-5",
          headerInset,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {headerTitle ?? (
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {title}
            </h1>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerTools}
          {/* token 用量：点开看按模型 / 每轮 / 每次调用 + 缓存命中率（与画布同一个弹窗） */}
          {conversationId && (
            <Badge
              variant="secondary"
              render={<button type="button" />}
              className="cursor-pointer tabular-nums hover:bg-accent"
              title={t("chat.thread.tokensTitle")}
              onClick={() => setUsageOpen(true)}
            >
              {t("chat.thread.tokens", { total: tokens.toLocaleString(currentLocale()) })}
            </Badge>
          )}
          {conversationId && workspaceDir && (
            <WorkspaceFilesButton
              conversationId={conversationId}
              workspaceDir={workspaceDir}
              permission={permission}
            />
          )}
        </div>
        {conversationId && (
          <TokenUsageDialog
            open={usageOpen}
            onOpenChange={setUsageOpen}
            queryKey={["conversation-token-usage", conversationId]}
            queryFn={() => getConversationTokenUsage(conversationId)}
            modelLabel={modelDisplayName}
          />
        )}
      </header>

      {/* 消息流。外层 relative 只为给「回到最新」按钮定位——它必须在滚动视口之外，
          否则会跟着内容一起滚走。 */}
      <div className="relative min-h-0 flex-1">
        {/* --chat-top-gap：发送后这条用户消息距视口顶的留白。数字只在这里出现，
            JS 侧只读不写死；要改成「距窗口顶 68px」就减去顶栏的 h-14（56px）。 */}
        <ScrollArea className="h-full [--chat-top-gap:68px]">
          <div
            ref={contentRef}
            data-testid="timeline"
            className="mx-auto max-w-3xl space-y-6 px-5 py-8"
          >
            {isLoading ? (
              <ThreadSkeleton />
            ) : isNewChat ? (
              // 引导页：没有输入框，先创建会话再进入（/agent 空路由）
              <div className="flex flex-col items-center gap-3 py-24 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                  <Sparkles className="size-6" />
                </div>
                <p className="text-base font-medium">{t("chat.thread.newTitle")}</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {t("chat.thread.newDescription")}
                </p>
                <Button onClick={onNewChat} disabled={creating} className="mt-1">
                  {creating ? <Loader className="animate-spin" /> : <Plus />}
                  {t("chat.thread.newButton")}
                </Button>
              </div>
            ) : showEmpty ? (
              <div className="flex flex-col items-center gap-3 py-24 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                  <Sparkles className="size-6" />
                </div>
                <p className="text-base font-medium">{t("chat.thread.emptyTitle")}</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {t("chat.thread.emptyDescription")}
                </p>
              </div>
            ) : (
              <>
                {rows.map((r, i) =>
                  r.row === "day" ? (
                    <DayDivider key={r.id} at={r.at} hideIfToday={r.first} />
                  ) : r.row === "activity" ? (
                    <ActivityGroup
                      key={r.id}
                      items={r.items}
                      // 末尾那组且本轮还在跑：组头显示「Working」
                      live={busy && i === rows.length - 1}
                      activeDetailId={activeDetailId}
                      onOpenDetail={onOpenDetail}
                    />
                  ) : r.item.kind === "media" ? (
                    // 媒体卡片与助手内容同列左对齐，conversationId 必有（卡片只在已有会话里出现）
                    <div key={r.item.id}>
                      <MediaGroup
                        conversationId={conversationId as string}
                        generationIds={r.item.generationIds}
                        mediaType={r.item.mediaType}
                      />
                    </div>
                  ) : r.item.kind === "preview" ? (
                    <PreviewCard key={r.item.id} spec={r.item.spec} />
                  ) : r.item.kind === "bg_task" ? (
                    <BackgroundTaskCard
                      key={r.item.id}
                      conversationId={conversationId as string}
                      taskId={r.item.taskId}
                    />
                  ) : r.item.kind === "notification" ? (
                    <TaskNotificationRow key={r.item.id} notification={r.item.notification} />
                  ) : r.item.kind === "mcp_app" ? (
                    <McpAppCard
                      key={r.item.id}
                      app={r.item.app}
                      conversationId={conversationId ?? undefined}
                      toolCallId={r.item.callId}
                      onFillPrompt={(text) => {
                        setDraft(text);
                        inputRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  ) : r.item.kind === "mcp_auth" ? (
                    <McpReconnectCard key={r.item.id} auth={r.item.auth} />
                  ) : r.item.kind === "qa" ? (
                    <AskUserAnswers key={r.item.id} answers={r.item.answers} />
                  ) : r.item.kind === "turn" ? (
                    <TurnFooter key={r.item.id} item={r.item} />
                  ) : (
                    <ChatMessage key={r.item.id} item={r.item} />
                  ),
                )}
                {busy && (
                  <ThinkingIndicator visible={thinkingVisible} startedAt={turnStartedAt} />
                )}
              </>
            )}
          </div>
          {/* 底部动态留白：撑出「把刚发的消息顶到视口顶部」所需的滚动余量。
              回复每长一截就等量收窄，填满一屏归零；同一轮内只缩不涨。 */}
          <div ref={spacerRef} aria-hidden />
        </ScrollArea>
        {!atLatest && <JumpToLatest onClick={jumpToLatest} />}
      </div>

      {/* 输入区（新会话引导页没有输入框，先创建会话再聊天） */}
      {!isNewChat && (
      <div className="shrink-0 px-5 pb-4">
        <div className="relative mx-auto max-w-3xl">
          {/* 任务计划：固定在输入框上方，可折叠/展开 */}
          {plan && <TaskPlanPanel todos={plan.todos} />}

          {/* 审批/提问面板：与任务计划同区域，固定在输入框上方。
              ask_user（单一调用且参数合法）走提问面板，其余走审批面板兜底 */}
          {approval && (
            <div data-testid="approval-panel">
              {isAskUserApproval(approval) ? (
                <QuestionPanel approval={approval} onSubmit={onDecide} />
              ) : (
                <ApprovalPanel approval={approval} onSubmit={onDecide} />
              )}
            </div>
          )}

          {/* 命令补全面板（输入 / 时浮在输入框上方，按分类 Built-in/GitHub 分组）*/}
          {showCmdMenu && (
            <div className="absolute bottom-full mb-2 max-h-72 w-full overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-lg">
              {groupedKinds.map(([kind, cmds]) => (
                <div key={kind}>
                  <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t(`chat.commandKind.${kind}`)}
                  </div>
                  {cmds.map((c) => {
                    const idx = flat.indexOf(c);
                    const active = idx === activeIndex;
                    return (
                      <button
                        key={c.name}
                        type="button"
                        ref={(el) => {
                          if (active)
                            el?.scrollIntoView({ block: "nearest" });
                        }}
                        aria-selected={active}
                        onMouseDown={(e) => {
                          e.preventDefault(); // 避免 textarea 失焦
                          pickCommand(c.name);
                        }}
                        onMouseMove={() => setActiveIndex(idx)}
                        className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left ${
                          active ? "bg-accent" : ""
                        }`}
                      >
                        <Slash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {c.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {c.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div
            onDragOver={onDragOver}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring",
              dragging && "border-ring bg-accent",
            )}
          >
            <ComposerAttachments
              items={attachments}
              onRemove={(p) => setAttachments((cur) => cur.filter((x) => x !== p))}
            />
            <Textarea
              ref={inputRef}
              aria-label={t("chat.thread.message")}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={busy ? t("chat.thread.placeholderBusy") : t("chat.thread.placeholder")}
              // 移动端必须 ≥16px（text-base）：iOS 对 <16px 的输入框聚焦会自动放大整页
              className="max-h-40 min-h-0 resize-none border-0 bg-transparent px-4 pt-3.5 pb-1.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
            {/* 工具条：左侧附件 + 模型切换 + 思考深度，右侧发送 */}
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <div className="flex min-w-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("chat.thread.attachFiles")}
                  title={t("chat.thread.attachFiles")}
                  disabled={busy}
                  onClick={() => void window.desktop.pickFiles().then(addAttachments)}
                >
                  <Paperclip />
                </Button>
                {workspaceDir && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={t("chat.thread.workspaceFolder")}
                    title={
                      canChangeWorkspace
                        ? t("chat.thread.workspaceChange", { dir: workspaceDir })
                        : t("chat.thread.workspaceLocked", { dir: workspaceDir })
                    }
                    disabled={busy || !canChangeWorkspace}
                    onClick={onChangeWorkspace}
                    className="max-w-40 text-muted-foreground hover:text-foreground disabled:opacity-100"
                  >
                    <Folder />
                    <span className="truncate">{workspaceDir.split("/").filter(Boolean).pop() ?? workspaceDir}</span>
                  </Button>
                )}
                <ModeSwitcher
                  value={modeId}
                  modes={modes}
                  onChange={onModeChange}
                  disabled={busy}
                />
                <PermissionSwitcher
                  value={permission}
                  onChange={onPermissionChange}
                  disabled={busy}
                />
                <ModelSwitcher
                  value={model}
                  onChange={onModelChange}
                  disabled={busy}
                />
                <ThinkingSwitcher
                  model={model}
                  value={thinkingLevel}
                  onChange={onThinkingLevelChange}
                  disabled={busy}
                  className="h-6"
                />
              </div>
              {busy ? (
                // 运行中：发送位变停止——立即中止本轮所有操作（LLM 流式/工具等待/媒体生成）
                <Button
                  size="icon-sm"
                  variant="destructive"
                  aria-label={t("chat.thread.stop")}
                  disabled={stopping}
                  onClick={onStop}
                  className="rounded-lg"
                >
                  {stopping ? (
                    <Loader className="animate-spin" />
                  ) : (
                    <Square className="fill-current" />
                  )}
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  aria-label={t("chat.thread.send")}
                  disabled={!canSend}
                  onClick={submit}
                  className="rounded-lg"
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t("chat.thread.disclaimer")}
          </p>
        </div>
      </div>
      )}
    </section>
  );
}

/**
 * 刷新/加载已有会话时的消息列表骨架屏。
 * 首屏 isLoading 即为 true，SSR 输出的 HTML 就带骨架——刷新先出骨架而非白屏。
 * 形态模拟真实消息流：右侧用户气泡 + 左侧助手文本行 + 工具 chip 行。
 */
function ThreadSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 rounded-2xl rounded-br-md" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-8 w-2/5 rounded-2xl rounded-br-md" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}
