import { expect, type Page, test } from "@playwright/test";

import {
  api,
  apiOk,
  conversationIdFromUrl,
  getConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import {
  createConversation,
  listConversations,
  rowAction,
  sidebar,
  sidebarRow,
  sidebarRows,
} from "./helpers/conversations";

// 会话列表：侧栏新建 / 重命名 / 置顶 / 搜索 / 删除，以及 /conversations 页。
// 前置会话尽量用接口建空会话（不触发模型）并起一个带随机标记的标题，便于在侧栏里认出来；
// 只有 /conversations 页（只显示首条消息 goal）需要真发一句话。afterEach 删掉本条建的全部会话。

loggedInAs("e2e-web-sessions@example.test");

/** 本条用例建的会话（afterEach 删掉）。 */
let created: string[] = [];

test.beforeEach(() => {
  created = [];
});

test.afterEach(async ({ page }) => {
  // 不用 helpers.deleteConversation：删除用例里已经删过的会返回 404，这里只要求最终不存在
  for (const id of created) {
    const res = await api(page, `/conversations/${id}`, { method: "DELETE" });
    if (res.code !== 0) expect(res.status).toBe(404);
  }
});

async function newConversation(page: Page, title?: string) {
  const id = await createConversation(page, title);
  created.push(id);
  return id;
}

test("new conversation appears in the sidebar", async ({ page }) => {
  const before = await listConversations(page);
  await page.goto("/agent");
  const untitled = sidebarRow(page, "New conversation");
  const untitledBefore = before.filter((c) => c.title === null && c.goal === "").length;
  await expect(sidebarRows(page)).toHaveCount(before.length);

  await sidebar(page).getByRole("button", { name: "New conversation", exact: true }).click();
  await page.waitForURL(/\/agent\/[^/]+$/);
  const id = conversationIdFromUrl(page);
  created.push(id);

  // 侧栏多出一条未命名的空会话（标题回退为 New conversation，状态徽标 New），顶栏同名
  await expect(sidebarRows(page)).toHaveCount(before.length + 1);
  await expect(untitled).toHaveCount(untitledBefore + 1);
  await expect(untitled.first().getByText("New", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New conversation");

  const conv = await getConversation(page, id);
  expect(conv.status).toBe("idle");
  expect(conv.title).toBeNull();
  // 新会话排在最前（未置顶的按创建时间倒序）
  const after = await listConversations(page);
  expect(after.filter((c) => c.pinnedAt === null)[0]?.id).toBe(id);
});

test("rename updates the sidebar, the header and the API title", async ({ page }) => {
  const tag = uniqueTag();
  const oldTitle = `E2E Before ${tag}`;
  const newTitle = `E2E After ${tag}`;
  const id = await newConversation(page, oldTitle);

  await page.goto(`/agent/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(oldTitle);

  await rowAction(page, sidebarRow(page, oldTitle), "Rename");
  const input = sidebar(page).getByRole("textbox", { name: "Conversation name" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(oldTitle);
  await input.fill(newTitle);
  await input.press("Enter");

  await expect(input).toBeHidden();
  await expect(sidebarRow(page, newTitle)).toHaveCount(1);
  await expect(sidebarRow(page, oldTitle)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
  await expect.poll(async () => (await getConversation(page, id)).title).toBe(newTitle);

  // 刷新后仍是新标题（不只是乐观更新）
  await page.reload();
  await expect(sidebarRow(page, newTitle)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
});

test("pin moves a conversation to the top, unpin restores the order", async ({ page }) => {
  const tag = uniqueTag();
  const older = `E2E Older ${tag}`;
  const newer = `E2E Newer ${tag}`;
  const olderId = await newConversation(page, older);
  const newerId = await newConversation(page, newer);

  await page.goto("/agent");
  const ours = sidebarRows(page).filter({ hasText: tag });
  // 未置顶按创建时间倒序：新的在前
  await expect(ours).toHaveText([new RegExp(newer), new RegExp(older)]);
  await expect(sidebar(page).getByText("Pinned", { exact: true })).toHaveCount(0);

  await rowAction(page, sidebarRow(page, older), "Pin");
  await expect(sidebarRows(page).first()).toContainText(older);
  await expect(ours).toHaveText([new RegExp(older), new RegExp(newer)]);
  await expect(sidebar(page).getByText("Pinned", { exact: true })).toBeVisible();
  await expect(sidebarRow(page, older).getByLabel("Pinned")).toBeVisible();
  await expect.poll(async () => (await listConversations(page))[0]?.id).toBe(olderId);
  expect((await listConversations(page))[0]?.pinnedAt).not.toBeNull();

  await rowAction(page, sidebarRow(page, older), "Unpin");
  await expect(ours).toHaveText([new RegExp(newer), new RegExp(older)]);
  await expect(sidebarRow(page, older).getByLabel("Pinned")).toHaveCount(0);
  await expect(sidebar(page).getByText("Pinned", { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => {
      const list = await listConversations(page);
      return list.find((c) => c.id === olderId)?.pinnedAt;
    })
    .toBeNull();
  const order = (await listConversations(page)).map((c) => c.id);
  expect(order.indexOf(newerId)).toBeLessThan(order.indexOf(olderId));
});

test("search filters the sidebar by title", async ({ page }) => {
  const tag = uniqueTag();
  const alpha = `E2E Alpha ${tag}`;
  const beta = `E2E Beta ${tag}`;
  await newConversation(page, alpha);
  await newConversation(page, beta);

  await page.goto("/agent");
  const search = sidebar(page).getByPlaceholder("Search conversations…");
  await expect(sidebarRow(page, tag)).toHaveCount(2);

  // 不区分大小写，只剩匹配的一条
  await search.fill(`alpha ${tag.toLowerCase()}`);
  await expect(sidebarRows(page)).toHaveCount(1);
  await expect(sidebarRows(page)).toContainText(alpha);

  await search.fill(tag);
  await expect(sidebarRows(page)).toHaveCount(2);

  await search.fill(`no-such-conversation-${tag}`);
  await expect(sidebarRows(page)).toHaveCount(0);
  await expect(sidebar(page).getByText(/^No conversations yet/)).toBeVisible();

  await search.fill("");
  await expect(sidebarRow(page, tag)).toHaveCount(2);
});

test("delete removes the conversation from the sidebar and the API", async ({ page }) => {
  const tag = uniqueTag();
  const title = `E2E Delete ${tag}`;
  const id = await newConversation(page, title);

  await page.goto(`/agent/${id}`);
  await rowAction(page, sidebarRow(page, title), "Delete");

  const dialog = page.getByRole("alertdialog", { name: "Delete conversation?" });
  await expect(dialog).toContainText(title);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(sidebarRow(page, title)).toHaveCount(0);
  // 删的是当前打开的会话 → 回到新会话页
  await page.waitForURL(/\/agent$/);

  const res = await api(page, `/conversations/${id}`);
  expect(res.status).toBe(404);
  expect((await listConversations(page)).some((c) => c.id === id)).toBe(false);
});

test("cancel in the delete dialog keeps the conversation", async ({ page }) => {
  const title = `E2E Keep ${uniqueTag()}`;
  const id = await newConversation(page, title);

  await page.goto("/agent");
  await rowAction(page, sidebarRow(page, title), "Delete");
  const dialog = page.getByRole("alertdialog", { name: "Delete conversation?" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(sidebarRow(page, title)).toHaveCount(1);
  expect((await getConversation(page, id)).title).toBe(title);
});

/** 发一句话建会话（POST /conversations 带 goal 会直接入队跑模型）；/conversations 页只显示 goal。 */
async function conversationWithGoal(page: Page, goal: string) {
  const { conversationId } = await apiOk<{ conversationId: string }>(page, "/conversations", {
    method: "POST",
    body: { goal },
  });
  created.push(conversationId);
  return conversationId;
}

test("the /conversations page lists the user's conversations", async ({ page }) => {
  test.setTimeout(240_000);
  const goal = `Reply with just the word OK. ${uniqueTag()}`;
  const id = await conversationWithGoal(page, goal);
  // 只关心列表展示：模型这轮成败不在本用例范围，状态列与接口一致即可
  const conv = await waitConversationIdle(page, id);

  await page.goto("/conversations");
  await expect(page.getByRole("heading", { name: "My conversations" })).toBeVisible();
  const item = page.getByRole("listitem").filter({ hasText: goal });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(conv.status);
});

test("open a conversation from the /conversations page", async ({ page }) => {
  // 回归：列表项曾是纯文本 <li>（无链接，进不去会话）、只显示首条消息（重命名后的标题看不到）
  const goal = `Reply with just the word OK. ${uniqueTag()}`;
  const id = await conversationWithGoal(page, goal);

  await page.goto("/conversations");
  const item = page.getByRole("listitem").filter({ hasText: goal });
  await expect(item).toHaveCount(1);

  // 重命名后列表显示新标题
  const title = `Renamed ${uniqueTag()}`;
  await apiOk(page, `/conversations/${id}`, { method: "PATCH", body: { title } });
  await page.reload();
  const renamed = page.getByRole("listitem").filter({ hasText: title });
  await expect(renamed).toHaveCount(1);

  await renamed.getByRole("link").click({ timeout: 5_000 });
  await page.waitForURL(new RegExp(`/agent/${id}$`));
});
