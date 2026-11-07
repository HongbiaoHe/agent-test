// conversations 用例专用工具：接口建会话 / 取列表，侧栏行定位。
import type { Locator, Page } from "@playwright/test";

import type { ConversationListItem } from "@/lib/api";

import { apiOk } from "../helpers";

/** GET /conversations：侧栏用的列表（后端按置顶时刻、再按创建时间倒序）。 */
export function listConversations(page: Page): Promise<ConversationListItem[]> {
  return apiOk<ConversationListItem[]>(page, "/conversations");
}

/** 用接口建一个空会话（idle，不触发模型）；给了 title 就顺手重命名，侧栏里才认得出是哪条。 */
export async function createConversation(page: Page, title?: string): Promise<string> {
  const { conversationId } = await apiOk<{ conversationId: string }>(page, "/conversations", {
    method: "POST",
    body: {},
  });
  if (title !== undefined) {
    await apiOk(page, `/conversations/${conversationId}`, { method: "PATCH", body: { title } });
  }
  return conversationId;
}

/** 桌面端常驻侧栏（<aside>，≥lg 显示；默认视口 1280 宽）。 */
export function sidebar(page: Page): Locator {
  return page.getByRole("complementary");
}

/**
 * 侧栏里的会话行（整行按钮），按 DOM 顺序 = 显示顺序。
 * 每行是「行按钮 + 紧随其后的 Conversation actions 菜单按钮」两个兄弟节点，以此区分其他按钮。
 */
export function sidebarRows(page: Page): Locator {
  return sidebar(page).locator('button:has(+ button[aria-label="Conversation actions"])');
}

/** 标题包含 text 的那一行。 */
export function sidebarRow(page: Page, text: string): Locator {
  return sidebarRows(page).filter({ hasText: text });
}

/** 打开某一行的「更多」菜单，点其中一项（Rename / Pin / Unpin / Delete）。 */
export async function rowAction(
  page: Page,
  row: Locator,
  item: "Rename" | "Pin" | "Unpin" | "Delete",
): Promise<void> {
  // 菜单按钮在桌面端悬停时才显示，先悬停整行
  await row.hover();
  await row.locator("..").getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
