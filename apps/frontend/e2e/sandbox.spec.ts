import { expect, test } from "@playwright/test";

import type { SandboxSettings, SandboxStatus } from "@/lib/api";

import { apiOk, loggedInAs, uniqueTag, waitConversationIdle } from "./helpers";
import { contentText, replyText, sendMessage, toolResults } from "./helpers/chat";
import {
  conversationTracker,
  openSandboxPanel,
  previewDialog,
  previewFrame,
} from "./helpers/sandbox";

// 沙箱：设置页只读展示、agent 写静态页 + preview_page 弹出可交互预览、文件面板打开同一页、execute。
// 打真实模型与真实沙箱（三个 spec 共用 e2e-web-sandbox 账号的同一个沙箱）。
// 第一次起沙箱可能要几十秒到几分钟，超时放宽。afterEach 删本条用例建的会话，沙箱不删。

loggedInAs("e2e-web-sandbox@example.test");

const conversations = conversationTracker();
test.beforeEach(() => conversations.reset());
test.afterEach(async ({ page }) => conversations.cleanup(page));

const PROVIDER_LABEL = { daytona: "Daytona", e2b: "E2B" } as const;

test("settings page shows the current provider and sandbox (read-only)", async ({ page }) => {
  const settings = await apiOk<SandboxSettings>(page, "/sandbox/settings");
  const status = await apiOk<SandboxStatus>(page, "/sandbox/status");

  await page.goto("/settings/sandbox");
  await expect(page.getByRole("heading", { name: "Sandbox", exact: true })).toBeVisible();

  // 提供方：选中的就是服务端返回的 current；未配置 key 的提供方禁用
  const providers = page.getByRole("radiogroup", { name: "Sandbox provider" });
  await expect(providers).toBeVisible();
  for (const p of settings.providers) {
    const radio = providers.getByRole("radio", { name: new RegExp(PROVIDER_LABEL[p.name]) });
    if (p.name === settings.current) await expect(radio).toBeChecked();
    else await expect(radio).not.toBeChecked();
    if (!p.configured) await expect(radio).toBeDisabled();
  }

  // 其它分区都在（只看不改）
  for (const title of ["Size", "Lifecycle", "Network", "Current sandbox"]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  // 当前沙箱：有沙箱时显示 ID，没有时显示「No sandbox yet」
  const current = page.locator("dl").filter({ hasText: "Status" });
  if (status.exists && status.id) await expect(current).toContainText(status.id);
  else await expect(current).toContainText("No sandbox yet");

  // 只读：页面打开前后设置不变
  const after = await apiOk<SandboxSettings>(page, "/sandbox/settings");
  expect(after.current).toBe(settings.current);
  expect(after.size).toBe(settings.size);
});

test("agent writes a page, preview_page opens it interactively, file panel previews it too", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const tag = uniqueTag();
  const heading = `Hello ${tag}`;
  const doneTag = `PAGE-DONE-${tag}`;
  const id = await conversations.open(page);

  await sendMessage(
    page,
    id,
    `用 write_file 在工作区写一个静态页 hello/index.html（覆盖已有文件）：` +
      `一个 h1，文字是「${heading}」；下面一个 id 为 inc 的按钮，文字是「Add one」；` +
      `按钮旁边一个 id 为 count 的 span，初始文字 0；用内联 <script> 实现点按钮后 count 加一。` +
      `不要引用任何外部资源。写完调用 preview_page 预览这个页面（path 填 hello/index.html 的完整工作区路径）。` +
      `预览成功后只回复这一个词：${doneTag}。不要问我任何问题。`,
  );

  // agent 调 preview_page 成功 → 弹窗自动打开，iframe 里的页面可交互
  const dialog = previewDialog(page);
  await expect(dialog).toBeVisible({ timeout: 300_000 });
  await expect(dialog).toContainText("/hello/index.html");
  const frame = previewFrame(page);
  await expect(frame.getByRole("heading", { name: heading })).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator("#count")).toHaveText("0");
  await frame.locator("#inc").click();
  await expect(frame.locator("#count")).toHaveText("1");
  // 焦点此刻在 iframe 里（跨源文档），Escape 到不了外层弹窗，用关闭按钮
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();

  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  const preview = toolResults(done, "preview_page").map(contentText).join("\n");
  expect(preview).toContain("opened");
  expect(replyText(done)).toContain(doneTag);

  // 消息流里留下预览卡片，可再次打开
  await page.getByRole("button", { name: "Preview", exact: true }).first().click();
  await expect(previewFrame(page).getByRole("heading", { name: heading })).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press("Escape");
  await expect(previewDialog(page)).toBeHidden();

  // 沙箱文件面板：hello/index.html 在树里，选中后「Preview page」打开同一个弹窗
  const sheet = await openSandboxPanel(page);
  await sheet.getByRole("button", { name: "hello", exact: true }).click();
  await sheet.getByRole("button", { name: "index.html", exact: true }).click();
  await expect(sheet.getByText("hello/index.html", { exact: true })).toBeVisible();
  // 文本预览里就是本次写的内容
  await expect(sheet.getByText(heading).first()).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole("button", { name: "Preview page", exact: true }).click();
  const panelFrame = previewFrame(page);
  await expect(panelFrame.getByRole("heading", { name: heading })).toBeVisible({ timeout: 30_000 });
  await panelFrame.locator("#inc").click();
  await expect(panelFrame.locator("#count")).toHaveText("1");
});

test("agent runs a shell command with execute", async ({ page }) => {
  test.setTimeout(420_000);
  const tag = uniqueTag();
  // 指令里只出现算式，输出里的 42 证明命令真的在 shell 里跑过
  const expected = `SBX-42-${tag}`;
  const id = await conversations.open(page);

  await sendMessage(
    page,
    id,
    `用 execute 工具运行这条命令（原样照抄）：echo SBX-$((6*7))-${tag}\n` +
      `只回复命令的输出，不要加其它文字，不要调用其它工具。`,
  );

  const done = await waitConversationIdle(page, id, 360_000);
  expect(done.status).toBe("done");
  expect(toolResults(done, "execute").map(contentText).join("\n")).toContain(expected);
  expect(replyText(done)).toContain(expected);
});
