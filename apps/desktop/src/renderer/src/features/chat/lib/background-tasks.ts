/** 会话后台任务：类型与解析函数同 Web（_lib/background-tasks.ts），列表 / 取消改走 agent-host RPC。 */
import { agent } from "@/lib/agent-client";

export type BackgroundKind = "watch" | "command" | "wakeup";
export type BackgroundStatus = "running" | "succeeded" | "failed" | "timeout" | "cancelled";

/** 后端 BackgroundTaskView（background.service.ts）。 */
export interface BackgroundTask {
  id: string;
  conversationId: string;
  kind: BackgroundKind;
  title: string;
  status: BackgroundStatus;
  result: { text: string; value?: string; exitCode?: number } | null;
  polls: number;
  deadlineAt: string;
  finishedAt: string | null;
  createdAt: string;
}

/** 会话里一条后台任务通知（role=user 消息的 content.notification）。 */
export interface TaskNotification {
  taskId: string;
  kind: string;
  title: string;
  status: string;
}

/** 会产出任务卡片的 agent 工具（结果 JSON 里带 taskId）。 */
export const BACKGROUND_TOOLS = ["watch_until", "run_in_background", "schedule_wakeup"];

export const bgTasksKey = (conversationId: string) => ["bg-tasks", conversationId] as const;

export function listBackgroundTasks(conversationId: string): Promise<BackgroundTask[]> {
  return agent.call("background.list", { conversationId });
}

export function cancelBackgroundTask(id: string): Promise<BackgroundTask> {
  return agent.call("background.cancel", { taskId: id });
}

function isTask(v: unknown): v is BackgroundTask {
  return (
    !!v &&
    typeof v === "object" &&
    "id" in v &&
    typeof v.id === "string" &&
    "status" in v &&
    typeof v.status === "string" &&
    "kind" in v &&
    typeof v.kind === "string"
  );
}

/** bg_task_update 事件就地合进任务列表缓存（没有就追加）。 */
export function applyTaskUpdate(
  list: BackgroundTask[] | undefined,
  payload: unknown,
): BackgroundTask[] | undefined {
  if (!isTask(payload)) return list;
  if (!list) return [payload];
  const i = list.findIndex((t) => t.id === payload.id);
  if (i < 0) return [...list, payload];
  const next = list.slice();
  next[i] = payload;
  return next;
}

/** 后台工具的结果（JSON 字符串）里取 taskId；报错结果没有 taskId → null。 */
export function parseStartedTaskId(content: unknown): string | null {
  try {
    const v: unknown = typeof content === "string" ? JSON.parse(content) : content;
    return v && typeof v === "object" && "taskId" in v && typeof v.taskId === "string"
      ? v.taskId
      : null;
  } catch {
    return null;
  }
}

export function parseNotification(v: unknown): TaskNotification | null {
  if (!v || typeof v !== "object") return null;
  if (!("taskId" in v) || typeof v.taskId !== "string") return null;
  return {
    taskId: v.taskId,
    kind: "kind" in v && typeof v.kind === "string" ? v.kind : "",
    title: "title" in v && typeof v.title === "string" ? v.title : "",
    status: "status" in v && typeof v.status === "string" ? v.status : "",
  };
}
