"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  Slash,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCommands } from "@/lib/api";

import type { Approval, Decision, ThreadItem } from "../_lib/thread";
import { ApprovalCard } from "./approval-card";
import { ChatMessage } from "./chat-message";
import { MediaCard } from "./media-card";
import { ModelSwitcher } from "./model-switcher";
import { TaskPlanPanel } from "./task-plan-panel";
import { ThinkingIndicator } from "./thinking-indicator";
import type { ToolItem } from "./tool-chip";
import { ToolGroup } from "./tool-group";

export function ChatThread({
  title,
  conversationId,
  items,
  approval,
  busy,
  isLoading,
  isNewChat,
  activeDetailId,
  onOpenDetail,
  onDecide,
  onSend,
  model,
  onModelChange,
  panelOpen,
  onTogglePanel,
  onOpenSidebar,
}: {
  title: string;
  conversationId: string | null;
  items: ThreadItem[];
  approval: Approval | null;
  busy: boolean;
  isLoading: boolean;
  isNewChat: boolean;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  onDecide: (d: Decision) => void;
  onSend: (text: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenSidebar: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 可用命令（/ 自动补全）
  const { data: commands = [] } = useQuery({
    queryKey: ["commands"],
    queryFn: listCommands,
    staleTime: 5 * 60_000,
  });

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

  // 按 domain 分组展示；flat 为菜单从上到下的实际可选顺序（键盘导航以此为准）
  const grouped = matches.reduce<Record<string, typeof matches>>((acc, c) => {
    (acc[c.domain] ??= []).push(c);
    return acc;
  }, {});
  const flat = Object.values(grouped).flat();

  // 候选项变化（输入过滤 / 菜单重新打开）时，默认高亮第一个
  const [prevPrefix, setPrevPrefix] = useState(cmdPrefix);
  if (prevPrefix !== cmdPrefix) {
    setPrevPrefix(cmdPrefix);
    setActiveIndex(0);
  }

  // 新消息 / 审批出现时滚动到底。只滚 ScrollArea 自己的 viewport（直接置 scrollTop），
  // 不用 bottomRef.scrollIntoView：后者会向上遍历、把每一个可滚祖先都滚动以露出锚点，
  // 在 busy 重渲染、内层 viewport 尚未 clamp 到最终高度的那一帧触发时，会误把外层
  // overflow:hidden 的 .h-screen/外壳一起滚动 → 整个 section 连同顶栏被顶上去、且因父级
  // 是 hidden 无法滚回（间歇性复现）。直接操作 viewport 物理上不可能移动任何祖先。
  useEffect(() => {
    const vp = bottomRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [items, approval]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
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

  // 把相邻的工具调用收成一组，交给 ToolGroup 渲染（≥2 折叠、单个仍按原 chip）；
  // 其余消息照常一条一条交给 ChatMessage。
  type Row =
    | { row: "msg"; item: ThreadItem }
    | { row: "tools"; id: string; tools: ToolItem[] };
  const rows: Row[] = [];
  for (const it of streamItems) {
    const last = rows[rows.length - 1];
    if (it.kind === "tool") {
      if (last?.row === "tools") last.tools.push(it);
      else rows.push({ row: "tools", id: it.id, tools: [it] });
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
    (lastItem?.kind === "tool" && !lastItem.done);
  const thinkingVisible = busy && !approval && !lastActive;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* 顶栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="打开会话列表"
            onClick={onOpenSidebar}
          >
            <PanelLeft />
          </Button>
          <h1 className="truncate text-sm font-semibold tracking-tight">
            {title}
          </h1>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={panelOpen ? "收起详情面板" : "展开详情面板"}
                onClick={onTogglePanel}
              />
            }
          >
            {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </TooltipTrigger>
          <TooltipContent>{panelOpen ? "收起详情" : "展开详情"}</TooltipContent>
        </Tooltip>
      </header>

      {/* 消息流 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-8">
          {isLoading ? (
            <ThreadSkeleton />
          ) : showEmpty ? (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Sparkles className="size-6" />
              </div>
              <p className="text-base font-medium">
                {isNewChat ? "开始一个新对话" : "这个会话还没有内容"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                把目标告诉 Agent，它会拆解任务并逐步执行。需要发邮件等敏感操作时会先请你审批。
              </p>
            </div>
          ) : (
            <>
              {rows.map((r) =>
                r.row === "tools" ? (
                  <ToolGroup
                    key={r.id}
                    tools={r.tools}
                    activeDetailId={activeDetailId}
                    onOpenDetail={onOpenDetail}
                  />
                ) : r.item.kind === "media" ? (
                  // 媒体卡片与助手内容同列左对齐，conversationId 必有（卡片只在已有会话里出现）。
                  <div key={r.item.id}>
                    <MediaCard
                      conversationId={conversationId as string}
                      generationId={r.item.generationId}
                      mediaType={r.item.mediaType}
                    />
                  </div>
                ) : (
                  <ChatMessage key={r.item.id} item={r.item} />
                ),
              )}
              {approval && (
                <div>
                  <ApprovalCard approval={approval} onDecide={onDecide} />
                </div>
              )}
              {busy && <ThinkingIndicator visible={thinkingVisible} />}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* 输入区 */}
      <div className="shrink-0 px-5 pb-4">
        <div className="relative mx-auto max-w-3xl">
          {/* 任务计划：固定在输入框上方，可折叠/展开 */}
          {plan && <TaskPlanPanel todos={plan.todos} />}

          {/* 命令补全面板（输入 / 时浮在输入框上方，按 domain 分组）*/}
          {showCmdMenu && (
            <div className="absolute bottom-full mb-2 max-h-72 w-full overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-lg">
              {Object.entries(grouped).map(([domain, cmds]) => (
                <div key={domain}>
                  <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {domain}
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
          <div className="rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring">
            <Textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={busy ? "Agent 正在处理…" : "给 Agent 发消息…（试试输入 /）"}
              // 移动端必须 ≥16px（text-base）：iOS 对 <16px 的输入框聚焦会自动放大整页
              className="max-h-40 min-h-0 resize-none border-0 bg-transparent px-4 pt-3.5 pb-1.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
            {/* 工具条：左侧模型切换，右侧发送 */}
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <ModelSwitcher
                value={model}
                onChange={onModelChange}
                disabled={busy}
              />
              <Button
                size="icon-sm"
                aria-label="发送"
                disabled={busy || !draft.trim()}
                onClick={submit}
                className="rounded-lg"
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Agent 可能会出错，请核对重要信息。
          </p>
        </div>
      </div>
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
