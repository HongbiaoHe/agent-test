import { expect, type Page, test } from "@playwright/test";

import type { BackgroundTask } from "@/app/agent/_lib/background-tasks";

import {
  apiOk,
  type ConversationDetail,
  getConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import { replyText, sendMessage, toolResults } from "./helpers/chat";
import { conversationTracker } from "./helpers/sandbox";

// 后台任务（schedule_wakeup）：到点系统通知唤醒 agent、卡片上取消后不再唤醒。
// 打真实模型。schedule_wakeup 的 delay_minutes 最小 1 分钟（后端 LIMITS.wakeup.minDelayMin，
// 更小的值会被夹到 1），所以「到点唤醒」至少要等 1 分钟。afterEach 删会话（同时取消在跑的任务）。

loggedInAs("e2e-web-sandbox@example.test");

const conversations = conversationTracker();
test.beforeEach(() => conversations.reset());
test.afterEach(async ({ page }) => conversations.cleanup(page));

function listTasks(page: Page, id: string) {
  return apiOk<BackgroundTask[]>(page, `/conversations/${id}/background-tasks`);
}

/** 后台任务结束后系统写进会话的通知消息（role=user，content.notification）。 */
function notifications(conv: ConversationDetail) {
  return conv.messages.filter(
    (m) =>
      m.role === "user" &&
      typeof m.content === "object" &&
      m.content !== null &&
      "notification" in m.content,
  );
}

test("schedule_wakeup fires, the notification wakes the agent and it replies with the note", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const tag = uniqueTag();
  const title = `Wake ${tag}`;
  const note = `NOTE-${tag}`;
  const id = await conversations.open(page);

  await sendMessage(
    page,
    id,
    `调用一次 schedule_wakeup：title 填「${title}」，delay_minutes 填 1，note 填「醒来后只回复 ${note}」。` +
      `不要调用其它工具。调用后直接结束本轮，只回复「已安排」。` +
      `之后收到这个任务的 <task-notification> 时，只回复 note 里要求的那个词，不要调用任何工具。`,
  );

  // 第一轮：发起任务后就结束，卡片出现、在跑
  const card = page.getByTestId("background-task-card").filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 180_000 });
  await expect(card).toContainText("Scheduled wakeup");
  const first = await waitConversationIdle(page, id, 180_000);
  expect(first.status).toBe("done");
  expect(toolResults(first, "schedule_wakeup")).toHaveLength(1);
  const [task] = await listTasks(page, id);
  expect(task.kind).toBe("wakeup");
  expect(task.status).toBe("running");
  expect(notifications(first)).toHaveLength(0);

  // 到点：任务完成 → 通知行 → agent 新一轮回复备注里的标记串
  await expect(card.getByText("Done", { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText(`Background task finished: ${title}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => {
      const conv = await getConversation(page, id);
      const [n] = notifications(conv);
      return conv.status === "done" && n ? replyText(conv, n.seq) : "";
    }, { timeout: 180_000, intervals: [2_000] })
    .toContain(note);
  await expect(page.getByText(new RegExp(`^\\s*${note}[。.]?\\s*$`))).toBeVisible();

  const tasks = await listTasks(page, id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].status).toBe("succeeded");
  expect(tasks[0].result?.text).toContain(note);
});

test("cancel a scheduled wakeup from its card: status cancelled, agent is not woken", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const tag = uniqueTag();
  const title = `Later ${tag}`;
  const id = await conversations.open(page);

  await sendMessage(
    page,
    id,
    `调用一次 schedule_wakeup：title 填「${title}」，delay_minutes 填 10，note 填「check ${tag}」。` +
      `不要调用其它工具。调用后直接结束本轮，只回复「已安排」。`,
  );

  const card = page.getByTestId("background-task-card").filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 180_000 });
  const idle = await waitConversationIdle(page, id, 180_000);
  expect(idle.status).toBe("done");
  const messageCount = idle.messages.length;

  const cancel = card.getByRole("button", { name: "Cancel background task" });
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  const cancelled = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/background-tasks\/[^/]+\/cancel$/.test(r.url()),
  );
  await cancel.click();
  expect((await cancelled).ok()).toBe(true);
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(cancel).toBeHidden();

  const [task] = await listTasks(page, id);
  expect(task.status).toBe("cancelled");
  expect(task.finishedAt).not.toBeNull();

  // 取消的任务不通知：一段时间内会话不被唤醒、不多出消息
  await page.waitForTimeout(5_000);
  const after = await getConversation(page, id);
  expect(after.status).toBe("done");
  expect(after.messages).toHaveLength(messageCount);
  expect(notifications(after)).toHaveLength(0);
  await expect(page.getByText(/^Background task /)).toHaveCount(0);
});
