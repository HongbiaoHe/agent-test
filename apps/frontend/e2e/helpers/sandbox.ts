// 沙箱 / 媒体 / 后台任务用例共用的工具：会话清理列表、沙箱文件面板、网页预览弹窗。
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";

import { deleteConversation } from "../helpers";
import { newConversation } from "./chat";

/** 本条用例建的会话：beforeEach 清空、afterEach 逐个删（沙箱不删，三个 spec 共用一个）。 */
export function conversationTracker() {
  let ids: string[] = [];
  return {
    reset() {
      ids = [];
    },
    async cleanup(page: Page) {
      for (const id of ids) await deleteConversation(page, id);
    },
    /** 打开 /agent 新建会话并记入清理列表。 */
    async open(page: Page): Promise<string> {
      await page.goto("/agent");
      const id = await newConversation(page);
      ids.push(id);
      return id;
    },
  };
}

/** 网页预览弹窗（SitePreviewDialog）：唯一带 iframe 的对话框。 */
export function previewDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.locator("iframe") });
}

export function previewFrame(page: Page): FrameLocator {
  return previewDialog(page).locator("iframe").contentFrame();
}

/** 点顶栏沙箱状态按钮，打开沙箱侧栏，等文件树出来（沙箱须已在运行）。 */
export async function openSandboxPanel(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Sandbox status", exact: true }).click();
  const sheet = page.getByRole("dialog").filter({ hasText: "Workspace files" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Running", { exact: true })).toBeVisible({ timeout: 30_000 });
  return sheet;
}
