import { expect, type Page, test } from "@playwright/test";

import {
  assistantText,
  conversationIdFromUrl,
  deleteConversation,
  getConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import { createMode, deleteAllModes, listModes } from "./helpers/modes";

// 模式引用模式作子 agent：设置页勾选与持久化 + 真实模型经 task 工具委派 + 下一轮记得 task 的结果
// （跨轮重放工具调用对）。账号专用；afterEach 删模式与本条建的会话。

loggedInAs("e2e-web-subagents@example.test");

const MODEL = "google-genai:gemini-3.8-flash";

let createdConversations: string[] = [];

test.beforeEach(async ({ page }) => {
  createdConversations = [];
  await deleteAllModes(page);
});

test.afterEach(async ({ page }) => {
  for (const id of createdConversations) await deleteConversation(page, id);
  await deleteAllModes(page);
});

/** 消息 content 里的子 agent 归属（主 agent 的行没有） */
function subagentOf(content: unknown): { callId: string; name: string } | null {
  if (!content || typeof content !== "object" || !("subagent" in content)) return null;
  const s = content.subagent;
  if (!s || typeof s !== "object" || !("callId" in s) || !("name" in s)) return null;
  return typeof s.callId === "string" && typeof s.name === "string"
    ? { callId: s.callId, name: s.name }
    : null;
}

/** tool_start 载荷里 task 调用的 id */
function taskCallId(content: unknown): string | undefined {
  if (!content || typeof content !== "object" || !("tool_calls" in content)) return undefined;
  const calls: unknown = content.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  for (const c of calls) {
    if (c && typeof c === "object" && "name" in c && c.name === "task" && "id" in c) {
      return typeof c.id === "string" ? c.id : undefined;
    }
  }
  return undefined;
}

async function sendMessage(page: Page, conversationId: string, text: string) {
  await page.getByPlaceholder("Message the agent… (try typing /)").fill(text);
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${conversationId}/messages`),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await posted).ok()).toBe(true);
}

test("settings: pick another mode as a sub-agent with a description; it persists and the card counts it", async ({
  page,
}) => {
  const writer = await createMode(page, { name: `E2E Writer ${uniqueTag()}`, systemPrompt: "写手。" });
  const lead = await createMode(page, { name: `E2E Lead ${uniqueTag()}`, systemPrompt: "主编。" });

  await page.goto("/settings/modes");
  await page.getByRole("button", { name: `Edit ${lead.name}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description").fill("规划并委派写作任务");
  // 子 agent 列表排除模式自己
  const writerRow = dialog.locator("label").filter({ hasText: writer.name });
  await expect(dialog.locator("label").filter({ hasText: lead.name })).toHaveCount(0);
  await writerRow.getByRole("checkbox").check();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api-backend/modes/${lead.id}`),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);

  const stored = (await listModes(page)).find((m) => m.id === lead.id);
  expect(stored?.description).toBe("规划并委派写作任务");
  expect(stored?.subagentModeIds).toEqual([writer.id]);

  await page.reload();
  await expect(page.getByText("1 sub-agent", { exact: false }).first()).toBeVisible();

  // 删掉被引用的模式：主编的子 agent 里随之去掉
  await page.request.delete(`/api-backend/modes/${writer.id}`);
  const after = (await listModes(page)).find((m) => m.id === lead.id);
  expect(after?.subagentModeIds).toEqual([]);
});

test("a real run delegates to the sub-agent via task; sub-agent events stay nested; the next turn remembers the task result", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const code = `SUB-${uniqueTag()}`;
  const writer = await createMode(page, {
    name: `Writer${uniqueTag()}`,
    description: "回答暗号问题的子 agent",
    systemPrompt: `无论收到什么任务，只回复这一行：暗号是 ${code}。不要调用任何工具，不要加别的文字。`,
    defaultModel: MODEL,
  });
  const lead = await createMode(page, {
    name: `Lead${uniqueTag()}`,
    systemPrompt:
      `你是主编。收到用户的第一条请求时，必须调用 task 工具，subagent_type 填「${writer.name}」，` +
      `description 填「告诉我暗号」，把任务委派给它；拿到结果后只回复「已完成」两个字，不要复述子 agent 的内容。` +
      "之后用户再问问题时，直接根据对话里已有的信息回答，不要再调用任何工具。",
    defaultModel: MODEL,
    subagentModeIds: [writer.id],
  });

  await page.goto("/agent");
  await page.evaluate((id) => localStorage.setItem("agent.mode", id), lead.id);
  const modesLoaded = page.waitForResponse((r) => r.url().endsWith("/api-backend/modes"));
  await page.reload();
  await modesLoaded;
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await page.waitForURL(/\/agent\/[^/]+$/);
  const id = conversationIdFromUrl(page);
  createdConversations.push(id);
  expect((await getConversation(page, id)).modeId).toBe(lead.id);

  await sendMessage(page, id, "开始吧");
  const first = await waitConversationIdle(page, id, 300_000);
  const diagnostics = JSON.stringify(
    first.messages.map((m) => ({ role: m.role, type: m.type, content: m.content })),
  ).slice(0, 6000);
  expect(first.status, diagnostics).toBe("done");

  // 主 agent 发起 task（主线事件，没有 subagent 归属）
  const taskStart = first.messages.find(
    (m) =>
      m.type === "tool_start" &&
      !subagentOf(m.content) &&
      JSON.stringify(m.content).includes('"name":"task"'),
  );
  expect(taskStart, diagnostics).toBeTruthy();
  const callId = taskCallId(taskStart?.content);
  expect(callId, diagnostics).toBeTruthy();

  // 子 agent 的正文带归属落库，且对到这次 task 调用
  const nested = first.messages.filter((m) => subagentOf(m.content)?.callId === callId);
  expect(nested.length, diagnostics).toBeGreaterThan(0);
  expect(nested.some((m) => m.type === "message" && JSON.stringify(m.content).includes(code))).toBe(
    true,
  );
  // task 的结果作为主线 tool_end 回来
  const taskEnd = first.messages.find(
    (m) =>
      m.type === "tool_end" &&
      !subagentOf(m.content) &&
      JSON.stringify(m.content).includes(`"toolCallId":"${callId}"`),
  );
  expect(JSON.stringify(taskEnd?.content), diagnostics).toContain(code);
  // 主线正文里没有子 agent 的暗号（主编只回「已完成」）：子 agent 的话没混进主对话
  const mainText = first.messages
    .filter((m) => m.role === "assistant" && m.type === "message" && !subagentOf(m.content))
    .map((m) => JSON.stringify(m.content))
    .join("\n");
  expect(mainText, diagnostics).not.toContain(code);

  // 界面：task 行显示子 agent 名，点开能看到子 agent 的嵌套正文
  const taskRow = page.getByRole("button").filter({ hasText: writer.name }).first();
  // 一轮结束后活动区收成「Worked for …」，先展开它
  if (!(await taskRow.isVisible())) {
    await page.getByRole("button", { name: /^Worked for / }).first().click();
  }
  await expect(taskRow).toBeVisible();
  await taskRow.click();
  await expect(page.getByText(code).first()).toBeVisible();

  // 下一轮：暗号只出现在上一轮 task 的工具结果里——答得出来 = 工具调用对被跨轮重放给了模型
  await sendMessage(page, id, "子 agent 刚才告诉你的暗号是什么？只回复暗号本身。");
  const second = await waitConversationIdle(page, id, 300_000);
  expect(second.status).toBe("done");
  const lastUser = Math.max(...second.messages.filter((m) => m.role === "user").map((m) => m.seq));
  const secondTurn = { ...second, messages: second.messages.filter((m) => m.seq > lastUser) };
  // 没有重新委派（否则答对也证明不了重放）
  expect(secondTurn.messages.some((m) => m.type === "tool_start")).toBe(false);
  expect(
    assistantText(secondTurn),
    JSON.stringify(secondTurn.messages.map((m) => ({ type: m.type, content: m.content }))).slice(0, 3000),
  ).toContain(code);
});
