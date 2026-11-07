import { expect, type Locator, type Page, test } from "@playwright/test";

import type { ModeCatalog } from "@/lib/api";

import {
  api,
  apiOk,
  assistantText,
  conversationIdFromUrl,
  deleteConversation,
  getConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import {
  createMode,
  deleteAllModes,
  getFragment,
  getGeneral,
  listFragments,
  listModes,
  resetFragments,
  resetGeneral,
  setFragment,
} from "./helpers/modes";

// agent 模式：设置页（通用模式 / 新建 / 编辑 / 删除 / 平台片段）+ 会话内切换 + 真实模型生效。
// 每条用例自己准备前置状态；afterEach 用接口清理：删模式、通用设置与平台片段恢复全默认、删本条建的会话。

loggedInAs("e2e-web-modes@example.test");

const DEFAULT_MODEL = "google-genai:gemini-3.8-flash";

/** 本条用例建的会话（afterEach 删掉）。 */
let createdConversations: string[] = [];

async function resetState(page: Page) {
  await deleteAllModes(page);
  await resetGeneral(page);
  await resetFragments(page);
}

test.beforeEach(async ({ page }) => {
  createdConversations = [];
  await resetState(page);
});

test.afterEach(async ({ page }) => {
  for (const id of createdConversations) await deleteConversation(page, id);
  await resetState(page);
});

/** 设置页里某个模式的卡片（以它的「Edit <name>」按钮定位）。 */
function modeCard(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("button", { name: `Edit ${name}`, exact: true }) });
}

/** 编辑器里的一行勾选项（工具按 code 名、技能按标题精确匹配）。 */
function optionCheckbox(dialog: Locator, page: Page, name: string, by: "code" | "title"): Locator {
  const marker =
    by === "code"
      ? page.locator("code").getByText(name, { exact: true })
      : page.getByText(name, { exact: true });
  return dialog.locator("label").filter({ has: marker }).getByRole("checkbox");
}

/** 在 /agent 新建会话，返回会话 id（记入清理列表）。 */
async function newConversation(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await page.waitForURL(/\/agent\/[^/]+$/);
  const id = conversationIdFromUrl(page);
  createdConversations.push(id);
  return id;
}

/** 在输入框发一条消息，等 POST /messages 返回（此时会话已是 queued）。 */
async function sendMessage(page: Page, conversationId: string, text: string) {
  const composer = page.getByPlaceholder("Message the agent… (try typing /)");
  await composer.fill(text);
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${conversationId}/messages`),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await posted).ok()).toBe(true);
}

/** 用会话内切换器选一个模式（按名称），并等接口里的 modeId 落定。 */
async function switchMode(page: Page, conversationId: string, name: string, modeId: string | null) {
  await page.getByRole("button", { name: "Conversation mode" }).click();
  await page
    .getByRole("listbox", { name: "Conversation mode" })
    .getByRole("option")
    .filter({ hasText: name })
    .first()
    .click();
  await expect
    .poll(async () => (await getConversation(page, conversationId)).modeId)
    .toBe(modeId);
}

test("general mode: edit prompt and default model, then restore", async ({ page }) => {
  const catalog = await apiOk<ModeCatalog>(page, "/modes/catalog");
  const defaults = await getGeneral(page);
  await page.goto("/settings/modes");

  // 通用卡片在最上面：Default 标记，没有删除按钮
  const firstCard = page.locator('[data-slot="card"]').first();
  await expect(firstCard.getByRole("button", { name: "Edit General", exact: true })).toBeVisible();
  await expect(firstCard.getByText("Default", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete General" })).toHaveCount(0);
  await expect(firstCard.getByText("Customized", { exact: true })).toHaveCount(0);

  // 打开编辑：名称只读、工具等只读说明、提示词为默认时 Restore default 禁用
  await page.getByRole("button", { name: "Edit General", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit General" });
  await expect(dialog.locator("#mode-name")).toBeDisabled();
  await expect(dialog.locator("#mode-name")).toHaveValue("General");
  await expect(
    dialog.getByText(new RegExp(`^All ${catalog.tools.length} tools · `)),
  ).toBeVisible();
  const restore = dialog.getByRole("button", { name: "Restore default" });
  await expect(restore).toBeDisabled();

  // 整体替换提示词，再连点两个占位符：各自另起一行追加在末尾
  const custom = `E2E general prompt ${uniqueTag()}`;
  const prompt = dialog.locator("#mode-prompt");
  await prompt.fill(custom);
  await dialog.getByRole("button", { name: "{{platform.language}}", exact: true }).click();
  await dialog.getByRole("button", { name: "{{platform.injection_guard}}", exact: true }).click();
  await expect(prompt).toHaveValue(
    `${custom}\n{{platform.language}}\n{{platform.injection_guard}}`,
  );
  await expect(restore).toBeEnabled();

  // 设默认模型并保存
  await dialog.getByRole("combobox", { name: "Default model" }).click();
  await page.getByRole("option", { name: "gemini-3.5-flash-lite", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(firstCard.getByText("Customized", { exact: true })).toBeVisible();
  await expect(firstCard.getByText("gemini-3.5-flash-lite", { exact: true })).toBeVisible();
  const saved = await getGeneral(page);
  expect(saved.isCustom).toBe(true);
  expect(saved.systemPrompt).toBe(`${custom}\n{{platform.language}}\n{{platform.injection_guard}}`);
  expect(saved.defaultModel).toBe("google-genai:gemini-3.5-flash-lite");

  // 恢复默认提示词，模型改回 Follow conversation，保存 → 标记消失
  await page.getByRole("button", { name: "Edit General", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Restore default" }).click();
  await expect(prompt).toHaveValue(defaults.defaultPrompt);
  await expect(dialog.getByRole("button", { name: "Restore default" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Default model" }).click();
  await page.getByRole("option", { name: "Follow conversation", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(firstCard.getByText("Customized", { exact: true })).toHaveCount(0);
  await expect(firstCard.getByText("gemini-3.5-flash-lite", { exact: true })).toHaveCount(0);
  const restored = await getGeneral(page);
  expect(restored.isCustom).toBe(false);
  expect(restored.defaultModel).toBeNull();
});

test("create a mode with tools, a skill and placeholders", async ({ page }) => {
  const name = `E2E Studio ${uniqueTag()}`;
  const custom = `You are the e2e image studio ${uniqueTag()}.`;
  await page.goto("/settings/modes");
  await page.getByRole("button", { name: "New mode" }).click();
  const dialog = page.getByRole("dialog", { name: "New mode" });

  await dialog.locator("#mode-name").fill(name);
  const prompt = dialog.locator("#mode-prompt");
  await prompt.fill(custom);
  await dialog.getByRole("button", { name: "{{platform.language}}", exact: true }).click();
  await dialog.getByRole("button", { name: "{{platform.injection_guard}}", exact: true }).click();
  await expect(prompt).toHaveValue(`${custom}\n{{platform.language}}\n{{platform.injection_guard}}`);

  for (const [label, by] of [
    ["generate_image", "code"],
    ["list_media_models", "code"],
    ["tvc-director", "title"],
  ] as const) {
    const box = optionCheckbox(dialog, page, label, by);
    await box.click();
    await expect(box).toBeChecked();
  }
  await expect(dialog.getByText("2 of", { exact: false }).first()).toBeVisible();

  // 预览最终提示词：自定义正文在前、占位符已展开、生图段在、后台任务段不在
  await dialog.getByRole("button", { name: "Preview prompt" }).click();
  const preview = page.getByRole("dialog", { name: "Final prompt" });
  const body = preview.locator("pre");
  await expect(body).toContainText(custom);
  const text = (await body.textContent()) ?? "";
  expect(text.startsWith(custom)).toBe(true);
  expect(text).not.toContain("{{");
  expect(text).toContain("## 生图");
  expect(text).not.toContain("## 后台任务与等待");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Create mode" }).click();
  await expect(dialog).toBeHidden();

  const card = modeCard(page, name);
  await expect(card).toBeVisible();
  await expect(card.getByText("2 tools", { exact: true })).toBeVisible();
  await expect(card.getByText("1 skill", { exact: true })).toBeVisible();

  const mode = (await listModes(page)).find((m) => m.name === name);
  expect(mode).toBeDefined();
  expect([...(mode?.toolNames ?? [])].sort()).toEqual(["generate_image", "list_media_models"]);
  expect(mode?.skillNames).toEqual(["tvc-director"]);
  expect(mode?.systemPrompt).toBe(`${custom}\n{{platform.language}}\n{{platform.injection_guard}}`);
});

test("unknown placeholder is rejected, then rename succeeds", async ({ page }) => {
  const name = `E2E Rename ${uniqueTag()}`;
  const original = `Edit me ${uniqueTag()}`;
  const mode = await createMode(page, { name, systemPrompt: original });
  await page.goto("/settings/modes");

  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Edit ${name}` });
  const prompt = dialog.locator("#mode-prompt");
  await expect(prompt).toHaveValue(original);
  await prompt.fill(`${original}\n{{platform.nope}}`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  // 保存被拒：弹窗不关、错误就地提示；库里的提示词没变
  await expect(dialog.getByRole("alert")).toHaveText("未知占位符：platform.nope");
  await expect(dialog).toBeVisible();
  const unchanged = (await listModes(page)).find((m) => m.id === mode.id);
  expect(unchanged?.systemPrompt).toBe(original);

  // 去掉占位符、改名后保存成功
  const renamed = `E2E Renamed ${uniqueTag()}`;
  await prompt.fill(original);
  await dialog.locator("#mode-name").fill(renamed);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(modeCard(page, renamed)).toBeVisible();

  const after = (await listModes(page)).find((m) => m.id === mode.id);
  expect(after?.name).toBe(renamed);
  expect(after?.systemPrompt).toBe(original);
});

test("switch modes inside a conversation", async ({ page }) => {
  const name = `E2E Director ${uniqueTag()}`;
  const mode = await createMode(page, {
    name,
    systemPrompt: "You direct TV commercials.",
    toolNames: ["generate_image"],
    skillNames: ["tvc-director"],
  });
  const allCommands = await apiOk<{ name: string }[]>(page, "/commands");
  // 前提：通用模式下还有别的命令，过滤才有意义
  expect(allCommands.map((c) => c.name)).toContain("email-compose");

  await page.goto("/agent");
  const id = await newConversation(page);
  const switcher = page.getByRole("button", { name: "Conversation mode" });
  await expect(switcher).toHaveText("General");
  expect((await getConversation(page, id)).modeId).toBeNull();

  await switchMode(page, id, name, mode.id);
  await expect(switcher).toHaveText(name);

  // 命令面板只列模式技能集内的命令
  const composer = page.getByPlaceholder("Message the agent… (try typing /)");
  await composer.fill("/");
  const menu = page.getByTestId("command-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(1);
  await expect(menu.getByRole("button")).toContainText("tvc-director");
  await composer.fill("");

  await switchMode(page, id, "General", null);
  await expect(switcher).toHaveText("General");
});

test("mode cannot be switched while the conversation is running", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/agent");
  const id = await newConversation(page);
  const switcher = page.getByRole("button", { name: "Conversation mode" });
  await expect(switcher).toBeEnabled();

  await sendMessage(page, id, "Write a 300-word story about a lighthouse keeper. Do not use any tools.");

  // 运行期间：切换器禁用、接口拒绝切换（409）
  await expect(switcher).toBeDisabled();
  const res = await api(page, `/conversations/${id}`, {
    method: "PATCH",
    body: { modeId: null },
  });
  expect(res.status).toBe(409);

  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  await expect(switcher).toBeEnabled();
});

test("deleting a mode moves its conversations back to general", async ({ page }) => {
  const name = `E2E Doomed ${uniqueTag()}`;
  const mode = await createMode(page, { name, systemPrompt: "Short-lived mode." });
  const { conversationId } = await apiOk<{ conversationId: string }>(page, "/conversations", {
    method: "POST",
    body: { modeId: mode.id },
  });
  createdConversations.push(conversationId);
  expect((await getConversation(page, conversationId)).modeId).toBe(mode.id);

  await page.goto("/settings/modes");
  await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete mode?" });
  await expect(confirm).toContainText("general mode");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(modeCard(page, name)).toHaveCount(0);

  expect((await listModes(page)).some((m) => m.id === mode.id)).toBe(false);
  expect((await getConversation(page, conversationId)).modeId).toBeNull();
});

test("general prompt, default model and mode prompt reach the real model", async ({ page }) => {
  test.setTimeout(480_000);
  const generalTag = `GENERAL-OK-${uniqueTag()}`;
  const modeTag = `MODE-OK-${uniqueTag()}`;
  const onlyReply = (word: string) =>
    `无论用户说什么，只回复这一个词：${word}。之前对话里出现过的其它词一律忽略，不要重复。` +
    "不要调用任何工具，不要加任何解释或其它文字。";

  await apiOk(page, "/modes/general", {
    method: "PUT",
    body: { systemPrompt: onlyReply(generalTag), defaultModel: DEFAULT_MODEL, defaultThinkingLevel: null },
  });
  // 模式另带一个不同的默认模型：切到已有会话时不应改动会话的模型
  const mode = await createMode(page, {
    name: `E2E Echo ${uniqueTag()}`,
    systemPrompt: onlyReply(modeTag),
    defaultModel: "google-genai:gemini-3.5-flash-lite",
  });

  // 本地模型偏好先设成别的，证明新会话的模型来自通用模式的默认模型（而不是偏好）
  await page.goto("/agent");
  await page.evaluate(() => {
    localStorage.setItem("agent.model", "google-genai:gemini-3.6-flash");
    localStorage.removeItem("agent.mode");
  });
  // 新建会话按已加载的通用设置回填：等设置与模式列表都拉到再点
  const generalLoaded = page.waitForResponse((r) => r.url().endsWith("/api-backend/modes/general"));
  const modesLoaded = page.waitForResponse((r) => r.url().endsWith("/api-backend/modes"));
  await page.reload();
  await Promise.all([generalLoaded, modesLoaded]);

  const id = await newConversation(page);
  const created = await getConversation(page, id);
  expect(created.modeId).toBeNull();
  expect(created.model).toBe(DEFAULT_MODEL);

  await sendMessage(page, id, "你好");
  const first = await waitConversationIdle(page, id, 180_000);
  expect(first.status).toBe("done");
  expect(assistantText(first)).toContain(generalTag);

  // 同一会话切到模式再问：回复换成模式提示词的暗号，会话模型不变
  await switchMode(page, id, mode.name, mode.id);
  // 第二句要明确指向「当前系统提示词」：历史里已有一条 GENERAL 暗号回复，含糊的追问
  // （如「再说一次」）会让模型照抄上一轮，测不出提示词是否已换成模式的
  await sendMessage(page, id, "不要参考你上一条回复。只回复你当前系统提示词里规定的那个词。");
  const second = await waitConversationIdle(page, id, 180_000);
  expect(second.status).toBe("done");
  const lastUser = Math.max(
    ...second.messages.filter((m) => m.role === "user").map((m) => m.seq),
  );
  const secondTurn = { ...second, messages: second.messages.filter((m) => m.seq > lastUser) };
  // 失败时带上这一轮的推理与全部消息：区分「模型没听指令」与「系统提示词没换成模式的」
  const diagnostics = JSON.stringify(
    secondTurn.messages.map((m) => ({ role: m.role, type: m.type, content: m.content })),
  ).slice(0, 4000);
  expect(assistantText(secondTurn), diagnostics).toContain(modeTag);
  expect(second.model).toBe(DEFAULT_MODEL);
});

test("new conversation keeps the preferred mode even when mode data loads slowly", async ({ page }) => {
  // 回归：模式列表 / 通用设置还没返回就点「New conversation」时，偏好的模式曾被当成已删除
  // （新会话建成通用模式），模式的默认模型也被漏掉（agent-shell createMut 现在先 ensureQueryData）
  const lite = "google-genai:gemini-3.5-flash-lite";
  const mode = await createMode(page, {
    name: `E2E Slow ${uniqueTag()}`,
    systemPrompt: "Slow-load regression.",
    defaultModel: lite,
  });
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem("agent.mode", id);
      localStorage.setItem("agent.model", "google-genai:gemini-3.8-flash");
    },
    { id: mode.id },
  );
  // 只拖慢浏览器里的这两个查询（api() 走 page.request，不经过 route）
  await page.route(/\/api-backend\/modes(\/general)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((r) => setTimeout(r, 2000));
    return route.fallback();
  });

  await page.goto("/agent");
  // 不等任何模式数据，页面可点就立刻新建
  const id = await newConversation(page);
  const conv = await getConversation(page, id);
  expect(conv.modeId).toBe(mode.id);
  expect(conv.model).toBe(lite);
});

// ---- 平台片段（{{platform.*}} 展开的正文，每个用户可改写，只能用 {{skills_dir}}）----

const FRAGMENT_IDS = [
  "platform.language",
  "platform.slash_command",
  "platform.skill_loading",
  "platform.injection_guard",
];

/** 片段区块里某一行。 */
function fragmentRow(page: Page, id: string): Locator {
  return page.getByTestId(`fragment-${id}`);
}

test("platform fragments: all four listed, none customized", async ({ page }) => {
  await page.goto("/settings/modes");
  const section = page.getByRole("region", { name: "Platform fragments" });
  await expect(section).toBeVisible();
  for (const id of FRAGMENT_IDS) {
    const row = fragmentRow(page, id);
    await expect(row.locator("code").getByText(id, { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `Edit ${id}`, exact: true })).toBeVisible();
    await expect(row.getByText("Customized", { exact: true })).toHaveCount(0);
  }
  // 首行就是默认正文的 ## 标题
  await expect(fragmentRow(page, "platform.language")).toContainText("## 回复语言");
  const list = await listFragments(page);
  expect(list.map((f) => f.id)).toEqual(FRAGMENT_IDS);
  expect(list.every((f) => !f.isCustom)).toBe(true);
});

test("edit a fragment with {{skills_dir}}; the general preview expands it", async ({ page }) => {
  const tag = `FRAG-E2E-${uniqueTag()}`;
  await page.goto("/settings/modes");
  await page.getByRole("button", { name: "Edit platform.language", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit platform.language" });
  const text = dialog.locator("#fragment-text");
  const defaults = await getFragment(page, "platform.language");
  await expect(text).toHaveValue(defaults.defaultText);
  await expect(dialog.getByRole("button", { name: "Restore default" })).toBeDisabled();

  // 清空后写新正文，把光标挪到「/end」之前，再用按钮插入变量（插在光标处，不是末尾）
  await text.fill("");
  await text.fill(`## Language\n${tag} skills at /end`);
  await text.press("End");
  for (let i = 0; i < "/end".length; i++) await text.press("ArrowLeft");
  await dialog.getByRole("button", { name: "Insert {{skills_dir}}", exact: true }).click();
  const expected = `## Language\n${tag} skills at {{skills_dir}}/end`;
  await expect(text).toHaveValue(expected);
  await expect(dialog.getByRole("button", { name: "Restore default" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = fragmentRow(page, "platform.language");
  await expect(row.getByText("Customized", { exact: true })).toBeVisible();
  await expect(row).toContainText("## Language");
  const saved = await getFragment(page, "platform.language");
  expect(saved.isCustom).toBe(true);
  expect(saved.text).toBe(expected);

  // 通用模式提示词保持默认（默认就引用 {{platform.language}}）：预览里是新正文，变量已换成实际路径
  await page.getByRole("button", { name: "Edit General", exact: true }).click();
  const general = page.getByRole("dialog", { name: "Edit General" });
  await general.getByRole("button", { name: "Preview prompt" }).click();
  const preview = page.getByRole("dialog", { name: "Final prompt" });
  const body = preview.locator("pre");
  await expect(body).toContainText(tag);
  const final = (await body.textContent()) ?? "";
  expect(final).toMatch(new RegExp(`${tag} skills at (/workspace)?/skills/end`));
  expect(final).not.toContain("{{skills_dir}}");
  expect(final).not.toContain("## 回复语言");
});

test("a fragment with another variable is rejected", async ({ page }) => {
  await page.goto("/settings/modes");
  await page.getByRole("button", { name: "Edit platform.language", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit platform.language" });
  await dialog.locator("#fragment-text").fill("Reply in {{foo}} at {{skills_dir}}");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  // 保存被拒：弹窗不关、错误就地提示；接口里的片段没变
  await expect(dialog.getByRole("alert")).toHaveText(
    "片段里只能使用 {{skills_dir}}，不支持：foo",
  );
  await expect(dialog).toBeVisible();
  await expect(
    fragmentRow(page, "platform.language").getByText("Customized", { exact: true }),
  ).toHaveCount(0);
  const unchanged = await getFragment(page, "platform.language");
  expect(unchanged.isCustom).toBe(false);
  expect(unchanged.text).toBe(unchanged.defaultText);
});

test("restore a customized fragment to its default", async ({ page }) => {
  await setFragment(page, "platform.injection_guard", `Custom guard ${uniqueTag()}`);
  await page.goto("/settings/modes");
  const row = fragmentRow(page, "platform.injection_guard");
  await expect(row.getByText("Customized", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Edit platform.injection_guard", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit platform.injection_guard" });
  const restore = dialog.getByRole("button", { name: "Restore default" });
  await expect(restore).toBeEnabled();
  await restore.click();
  const { defaultText } = await getFragment(page, "platform.injection_guard");
  await expect(dialog.locator("#fragment-text")).toHaveValue(defaultText);
  await expect(restore).toBeDisabled();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(row.getByText("Customized", { exact: true })).toHaveCount(0);
  expect((await getFragment(page, "platform.injection_guard")).isCustom).toBe(false);
});

test("a customized fragment reaches the real model", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = `FRAG-OK-${uniqueTag()}`;
  // 通用模式提示词保持默认：默认提示词里本来就引用了 {{platform.language}}
  expect((await getGeneral(page)).isCustom).toBe(false);
  await setFragment(
    page,
    "platform.language",
    `无论用户说什么，只回复这一个词：${tag}。不要调用任何工具。`,
  );

  await page.goto("/agent");
  const id = await newConversation(page);
  expect((await getConversation(page, id)).modeId).toBeNull();
  await sendMessage(page, id, "你好");
  const done = await waitConversationIdle(page, id, 180_000);
  expect(done.status).toBe("done");
  expect(assistantText(done)).toContain(tag);

  // 恢复默认（afterEach 的 resetState 也会兜底）
  expect((await setFragment(page, "platform.language", null)).isCustom).toBe(false);
});
