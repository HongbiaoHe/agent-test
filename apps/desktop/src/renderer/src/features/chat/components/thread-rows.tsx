import { McpAppCard, McpReconnectCard } from "@/components/mcp";
import { VideoProjectCard } from "@/features/video-editor";

import type { ThreadItem } from "../lib/thread";
import { isSameDay } from "../lib/time";
import { type ActivityItem, ActivityGroup } from "./activity-group";
import { AskUserAnswers } from "./ask-user-answers";
import { BackgroundTaskCard, TaskNotificationRow } from "./background-task-card";
import { ChatMessage } from "./chat-message";
import { DayDivider } from "./day-divider";
import { MediaGroup } from "./media-card";
import { PreviewCard } from "./preview-card";
import { TurnFooter } from "./turn-footer";

/**
 * 消息流的一串 thread item → 行：相邻的思考与工具调用收成一个活动组（ActivityGroup，单项不加组头），
 * 其余消息一条一条渲染。主线程与 task 子线程（子 agent 的嵌套过程）共用这一份。
 * 用户消息与上一条用户消息不在同一天时，前面插一条日期分隔线；第一条用户消息前也插，
 * 但标 first —— 是今天就不显示（全是今天的会话不出分隔线）。
 */
export function ThreadRows({
  items,
  live,
  conversationId,
  activeDetailId,
  onOpenDetail,
  onFillPrompt,
}: {
  items: ThreadItem[];
  /** 这串 item 所在的线程还在跑：末尾那个活动组的组头显示「Working」 */
  live: boolean;
  conversationId: string | null;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  /** MCP App 卡片请求把一段文字填进输入框 */
  onFillPrompt: (text: string) => void;
}) {
  type Row =
    | { row: "msg"; item: ThreadItem }
    | { row: "activity"; id: string; items: ActivityItem[] }
    | { row: "day"; id: string; at: number; first: boolean };
  const rows: Row[] = [];
  let prevUserAt: number | null = null;
  for (const it of items) {
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

  // task chip 展开后的子线程：同一套行渲染（子 agent 只展开一层，子线程里不会再有子线程）
  const renderSub = (sub: ThreadItem[], subLive: boolean) => (
    <ThreadRows
      items={sub}
      live={subLive}
      conversationId={conversationId}
      activeDetailId={activeDetailId}
      onOpenDetail={onOpenDetail}
      onFillPrompt={onFillPrompt}
    />
  );

  return (
    <>
      {rows.map((r, i) =>
    r.row === "day" ? (
      <DayDivider key={r.id} at={r.at} hideIfToday={r.first} />
    ) : r.row === "activity" ? (
      <ActivityGroup
        key={r.id}
        items={r.items}
        // 末尾那组且本轮还在跑：组头显示「Working」
        live={live && i === rows.length - 1}
        activeDetailId={activeDetailId}
        onOpenDetail={onOpenDetail}
        renderSub={renderSub}
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
    ) : r.item.kind === "video_project" ? (
      <VideoProjectCard key={r.item.id} conversationId={conversationId as string} info={r.item.info} />
    ) : r.item.kind === "bg_task" ? (
      <BackgroundTaskCard key={r.item.id} conversationId={conversationId as string} taskId={r.item.taskId} />
    ) : r.item.kind === "notification" ? (
      <TaskNotificationRow key={r.item.id} notification={r.item.notification} />
    ) : r.item.kind === "mcp_app" ? (
      <McpAppCard
        key={r.item.id}
        app={r.item.app}
        conversationId={conversationId ?? undefined}
        toolCallId={r.item.callId}
        onFillPrompt={onFillPrompt}
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
    </>
  );
}
