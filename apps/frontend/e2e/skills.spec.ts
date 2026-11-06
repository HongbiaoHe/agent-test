import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  apiOk,
  assistantText,
  deleteConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import {
  createCustomSkill,
  deleteUserSkills,
  getSkill,
  listCommands,
  listSkills,
} from "./helpers/skills";

// 技能：设置页新建 / 编辑 / 启停 / 删除手写技能 + / 命令面板联动 + 会话里 /技能名 调用（真实模型）
// + 从 GitHub 安装。afterEach 用接口删掉本账号的非内置技能和本条建的会话。

loggedInAs("e2e-web-skills@example.test");

const COMPOSER = "Message the agent… (try typing /)";

let createdConversations: string[] = [];

test.beforeEach(async ({ page }) => {
  createdConversations = [];
  await deleteUserSkills(page);
});

test.afterEach(async ({ page }) => {
  for (const id of createdConversations) await deleteConversation(page, id);
  await deleteUserSkills(page);
});

/** 一个新技能的名字（小写，也是 /命令 名）与它被调用时应回复的标记。 */
function newSkillSpec() {
  const tag = uniqueTag();
  const name = `e2e-skill-${tag.toLowerCase()}`;
  const marker = `SKILL-OK-${tag}`;
  return {
    name,
    marker,
    description: `E2E test skill ${tag}. Use only when the user invokes /${name}.`,
    body: `被调用时只回复这一串：${marker}\n\n不要调用任何工具，不要加任何解释或其它文字。`,
  };
}

/** 列表里某个技能的卡片（卡片本身是「View <name> details」按钮）。 */
function skillCard(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `View ${name} details`, exact: true });
}

/** 用接口建空会话并打开它（记入清理列表）。 */
async function openNewConversation(page: Page): Promise<string> {
  const { conversationId } = await apiOk<{ conversationId: string }>(page, "/conversations", {
    method: "POST",
    body: {},
  });
  createdConversations.push(conversationId);
  await page.goto(`/agent/${conversationId}`);
  return conversationId;
}

/** 在输入框敲「/」打开命令面板，返回面板（结束时由调用方清空输入框）。 */
async function openCommandMenu(page: Page): Promise<Locator> {
  await page.getByPlaceholder(COMPOSER).fill("/");
  const menu = page.getByTestId("command-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** 命令面板里某个命令的选项（按名字精确匹配）。 */
function commandOption(menu: Locator, name: string): Locator {
  return menu.getByRole("button").filter({ has: menu.page().getByText(name, { exact: true }) });
}

test("create, edit, disable, re-enable and delete a custom skill", async ({ page }) => {
  const skill = newSkillSpec();
  await page.goto("/settings/skills");

  // 新建
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New skill" });
  await create.locator("#custom-skill-name").fill(skill.name);
  await create.locator("#custom-skill-description").fill(skill.description);
  await create.getByRole("textbox", { name: "Instructions (Markdown)" }).fill(skill.body);
  await create.getByRole("button", { name: "Create skill", exact: true }).click();
  await expect(create).toBeHidden();

  const card = skillCard(page, skill.name);
  await expect(card).toBeVisible();
  await expect(card).toContainText(skill.description);
  await expect(card.getByText("Custom", { exact: true })).toBeVisible();
  const created = await getSkill(page, skill.name);
  expect(created.kind).toBe("custom");
  expect(created.enabled).toBe(true);
  expect(created.body).toBe(skill.body);

  // 编辑说明：弹窗回填原值，名字锁定；保存后列表与接口都变了，正文不动
  const newDescription = `Edited ${skill.description}`;
  await card.getByRole("button", { name: "Edit skill" }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${skill.name}` });
  await expect(edit.locator("#custom-skill-name")).toBeDisabled();
  const description = edit.locator("#custom-skill-description");
  await expect(description).toHaveValue(skill.description);
  await description.fill(newDescription);
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(card).toContainText(newDescription);
  const edited = await getSkill(page, skill.name);
  expect(edited.description).toBe(newDescription);
  expect(edited.body).toBe(skill.body);

  // 停用：开关翻转，/commands 不再有它；整页打开会话，/ 面板里也没有
  await card.getByRole("switch", { name: "Disable skill" }).click();
  // 开关的 aria-label 随 enabled 翻转（Disable skill ↔ Enable skill）
  await expect(card.getByRole("switch", { name: "Enable skill" })).toBeVisible();
  await expect.poll(async () => (await getSkill(page, skill.name)).enabled).toBe(false);
  expect((await listCommands(page)).map((c) => c.name)).not.toContain(skill.name);

  await openNewConversation(page);
  let menu = await openCommandMenu(page);
  await expect(menu.getByRole("button").first()).toBeVisible();
  await expect(commandOption(menu, skill.name)).toHaveCount(0);

  // 重新启用：/ 面板里又出现，带新说明
  await page.goto("/settings/skills");
  await skillCard(page, skill.name).getByRole("switch", { name: "Enable skill" }).click();
  await expect(skillCard(page, skill.name).getByRole("switch", { name: "Disable skill" })).toBeVisible();
  await expect.poll(async () => (await getSkill(page, skill.name)).enabled).toBe(true);

  await page.goto(`/agent/${createdConversations[0]}`);
  menu = await openCommandMenu(page);
  await expect(commandOption(menu, skill.name)).toHaveCount(1);
  await expect(commandOption(menu, skill.name)).toContainText(newDescription);

  // 删除：二次确认后从列表消失，接口里也没了
  await page.goto("/settings/skills");
  const toDelete = skillCard(page, skill.name);
  await toDelete.getByRole("button", { name: "Delete skill" }).click();
  await toDelete.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillCard(page, skill.name)).toHaveCount(0);
  expect((await listSkills(page)).map((s) => s.name)).not.toContain(skill.name);
});

/**
 * 从会话经应用内导航（侧栏 Settings → Skills）到技能设置页，对某个技能做一次操作，再用设置页的
 * Back（router.back()）一路退回会话。全程不整页刷新，React Query 缓存保留。
 */
async function viaSettings(
  page: Page,
  conversationId: string,
  skillName: string,
  act: (card: Locator) => Promise<void>,
) {
  await page.getByPlaceholder(COMPOSER).fill("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForURL(/\/settings\/profile$/);
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await page.waitForURL(/\/settings\/skills$/);
  await act(skillCard(page, skillName));

  const back = page.getByRole("button", { name: "Back", exact: true });
  for (let i = 0; i < 3 && !page.url().endsWith(`/agent/${conversationId}`); i++) {
    const before = page.url();
    await back.click();
    await page.waitForURL((u) => u.href !== before);
  }
  await expect(page).toHaveURL(new RegExp(`/agent/${conversationId}$`));
}

test("skill toggles and deletes reach the command menu without a page reload", async ({ page }) => {
  // 回归：设置页启停 / 删除技能后没让 ["commands"] 缓存失效（staleTime 5 分钟），
  // 经应用内导航回到会话时，/ 面板仍列出已停用 / 已删除的技能（选了发出去后端报命令不存在）
  const skill = newSkillSpec();
  await createCustomSkill(page, skill);
  const id = await openNewConversation(page);
  await expect(commandOption(await openCommandMenu(page), skill.name)).toHaveCount(1);

  await viaSettings(page, id, skill.name, async (card) => {
    await card.getByRole("switch", { name: "Disable skill" }).click();
    await expect(card.getByRole("switch", { name: "Enable skill" })).toBeVisible();
  });
  await expect(commandOption(await openCommandMenu(page), skill.name)).toHaveCount(0);

  await viaSettings(page, id, skill.name, async (card) => {
    await card.getByRole("switch", { name: "Enable skill" }).click();
    await expect(card.getByRole("switch", { name: "Disable skill" })).toBeVisible();
  });
  await expect(commandOption(await openCommandMenu(page), skill.name)).toHaveCount(1);

  await viaSettings(page, id, skill.name, async (card) => {
    await card.getByRole("button", { name: "Delete skill" }).click();
    await card.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await expect(card).toHaveCount(0);
  });
  await expect(commandOption(await openCommandMenu(page), skill.name)).toHaveCount(0);
});

test("invoke a custom skill with /name in a conversation", async ({ page }) => {
  test.setTimeout(300_000);
  const skill = newSkillSpec();
  await createCustomSkill(page, skill);
  const id = await openNewConversation(page);

  // 从 / 面板选中命令：输入框补成「/<name> 」
  const menu = await openCommandMenu(page);
  await commandOption(menu, skill.name).click();
  const composer = page.getByPlaceholder(COMPOSER);
  await expect(composer).toHaveValue(`/${skill.name} `);
  await composer.pressSequentially("开始");

  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${id}/messages`),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await posted).ok()).toBe(true);

  const conv = await waitConversationIdle(page, id, 180_000);
  expect(conv.status).toBe("done");
  expect(assistantText(conv)).toContain(skill.marker);
  await expect(page.getByText(skill.marker).first()).toBeVisible();
});

test("install a skill from GitHub", async ({ page }) => {
  // 联网：后端从 codeload.github.com 拉 anthropics/skills 的 tarball（约 4MB）。
  // 网络不通的环境设 WEB_E2E_SKIP_GITHUB=1 跳过。
  test.skip(process.env.WEB_E2E_SKIP_GITHUB === "1", "WEB_E2E_SKIP_GITHUB=1：跳过需要访问 GitHub 的用例");
  test.setTimeout(180_000);
  const repo = "anthropics/skills";
  const path = "skills/brand-guidelines";
  const name = "brand-guidelines";

  await page.goto("/settings/skills");
  await page.getByLabel("Repository").fill(repo);
  await page.getByLabel("Path").fill(path);
  const installed = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api-backend/skills/install"),
    { timeout: 150_000 },
  );
  await page.getByRole("button", { name: "Install", exact: true }).click();
  expect((await installed).ok()).toBe(true);

  // 列表里出现在 GitHub 分组，带「从源重装」按钮（不是 Edit）；表单清空
  const card = skillCard(page, name);
  await expect(card).toBeVisible();
  await expect(card.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Update skill" })).toBeVisible();
  await expect(page.getByLabel("Repository")).toHaveValue("");
  const skill = await getSkill(page, name);
  expect(skill.kind).toBe("github");
  expect(skill.source).toBe(`github:${repo}#${path}@main`);
  expect(skill.files).toContain("SKILL.md");
  expect((await listCommands(page)).map((c) => c.name)).toContain(name);
});
