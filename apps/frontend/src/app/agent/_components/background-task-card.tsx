"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  BellRing,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  type LucideIcon,
  Radar,
  SquareTerminal,
  X,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  type BackgroundKind,
  type BackgroundStatus,
  type BackgroundTask,
  bgTasksKey,
  cancelBackgroundTask,
  listBackgroundTasks,
  type TaskNotification,
} from "../_lib/background-tasks";
import { Elapsed } from "./elapsed";

const KIND_ICON: Record<BackgroundKind, LucideIcon> = {
  watch: Radar,
  command: SquareTerminal,
  wakeup: AlarmClock,
};

const KIND_LABEL: Record<BackgroundKind, string> = {
  watch: "Watching",
  command: "Background command",
  wakeup: "Scheduled wakeup",
};

const STATUS_LABEL: Record<BackgroundStatus, string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  timeout: "Timed out",
  cancelled: "Cancelled",
};

function StatusBadge({ status }: { status: BackgroundStatus }) {
  const Icon =
    status === "running"
      ? Loader2
      : status === "succeeded"
        ? CircleCheck
        : status === "cancelled"
          ? X
          : status === "timeout"
            ? Clock
            : CircleX;
  return (
    <Badge
      variant={status === "failed" || status === "timeout" ? "destructive" : "secondary"}
      className="gap-1"
    >
      <Icon
        className={cn(
          "size-3",
          status === "running" && "animate-spin",
          status === "succeeded" && "text-success",
        )}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** 会话的后台任务列表：卡片与通知行共用一份缓存，实时由 bg_task_update 事件写入（见 use-conversation）。 */
export function useBackgroundTasks(conversationId: string) {
  return useQuery({
    queryKey: bgTasksKey(conversationId),
    queryFn: () => listBackgroundTasks(conversationId),
    staleTime: Infinity,
  });
}

/**
 * 后台任务卡片：agent 发起 watch_until / run_in_background / schedule_wakeup 后出现在工具 chip 下方。
 * 进行中显示已运行时长与轮询次数、可取消；结束后可展开看结果（就是通知给 agent 的那段文本）。
 */
export function BackgroundTaskCard({
  conversationId,
  taskId,
}: {
  conversationId: string;
  taskId: string;
}) {
  const qc = useQueryClient();
  const query = useBackgroundTasks(conversationId);
  const task = query.data?.find((t) => t.id === taskId);
  const [open, setOpen] = useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelBackgroundTask(taskId),
    onSuccess: (updated) =>
      qc.setQueryData<BackgroundTask[]>(bgTasksKey(conversationId), (prev) =>
        prev?.map((t) => (t.id === updated.id ? updated : t)),
      ),
  });

  if (!task) return null;
  const Icon = KIND_ICON[task.kind];
  const running = task.status === "running";
  const startedAt = Date.parse(task.createdAt);
  const endedAt = task.finishedAt ? Date.parse(task.finishedAt) : undefined;

  return (
    <div className="rounded-xl border border-border bg-card p-3" data-testid="background-task-card">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{task.title}</p>
          <p className="text-xs text-muted-foreground">
            {KIND_LABEL[task.kind]} · <Elapsed startedAt={startedAt} endedAt={endedAt} />
            {task.kind !== "wakeup" && task.polls > 0 && ` · ${task.polls} checks`}
            {task.kind === "wakeup" && running &&
              ` · wakes at ${new Date(task.deadlineAt).toLocaleTimeString()}`}
          </p>
        </div>
        <StatusBadge status={task.status} />
        {running && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel background task"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? <Loader2 className="animate-spin" /> : <X />}
          </Button>
        )}
      </div>
      {task.result?.text && !running && (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide result" : "Show result"}
          </button>
          {open && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground/90">
              {task.result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 后台任务结束、唤醒 agent 的那条通知：不是用户发言，渲染成居中的系统行。 */
export function TaskNotificationRow({ notification }: { notification: TaskNotification }) {
  const ok = notification.status === "succeeded";
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
      <BellRing className={cn("size-3.5", ok ? "text-success" : "text-warning")} />
      <span>
        Background task {ok ? "finished" : notification.status}:{" "}
        <span className="font-medium text-foreground">{notification.title}</span>
      </span>
    </div>
  );
}
