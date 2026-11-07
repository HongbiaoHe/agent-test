import { expect, type Page, test } from "@playwright/test";

import {
  deleteConversation,
  getConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import {
  COMPOSER_PLACEHOLDER,
  contentText,
  getChatConversation,
  newConversation,
  replyText,
  sendMessage,
  solidPng,
  toolResults,
} from "./helpers/chat";

// 对话核心：发消息与流式、模型 / 思考档位、审批（send_email）、ask_user 提问面板、停止、
// 任务计划与 token 用量、附件上传展示。都打真实模型，用随机标记串 + 明确指令约束输出。
// afterEach 用接口删掉本条用例建的全部会话。

loggedInAs("e2e-web-chat@example.test");

/** 本条用例建的会话（afterEach 删掉）。 */
let createdConversations: string[] = [];

test.beforeEach(() => {
  createdConversations = [];
});

test.afterEach(async ({ page }) => {
  for (const id of createdConversations) await deleteConversation(page, id);
});

/** 打开 /agent 新建会话并记入清理列表。 */
async function openNewConversation(page: Page): Promise<string> {
  await page.goto("/agent");
  const id = await newConversation(page);
  createdConversations.push(id);
  return id;
}

/** 某类消息里最后一条的 seq（没有则 -1）。 */
function lastSeq(conv: Awaited<ReturnType<typeof getConversation>>, type: string): number {
  return Math.max(-1, ...conv.messages.filter((m) => m.type === type).map((m) => m.seq));
}

test("send a message: running state, streamed reply, status done", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = `ECHO-${uniqueTag()}`;
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    `只回复这一个词：${tag}。不要调用任何工具，不要加任何解释或其它文字。`,
  );

  // 运行中：发送位变成 Stop、输入框占位换成忙碌文案
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await expect(page.getByPlaceholder("Agent is on the case…")).toBeVisible();

  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  expect(replyText(done)).toContain(tag);

  // 界面：回复展示出来，Stop 回到 Send
  // 用户气泡 / 标题里的是整句指令；只有回复段落是这一个词本身
  await expect(page.getByText(new RegExp(`^\\s*${tag}[。.]?\\s*$`))).toBeVisible();
  await expect(stop).toBeHidden();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible();
});

test("message sent right after opening a conversation keeps its bubble and running state", async ({
  page,
}) => {
  // 回归：历史还在加载（骨架屏）时就能点发送；历史随后返回会重置实时增量、把状态同步成 idle，
  // 乐观插入的用户气泡丢失、整轮看不到 Stop。现在加载完成前发送按钮禁用。
  test.setTimeout(300_000);
  const tag = `EARLY-${uniqueTag()}`;
  await page.goto("/agent");
  // 只拖慢浏览器里拉会话详情的 GET（api() 走 page.request，不经过 route）
  await page.route(/\/api-backend\/conversations\/[^/]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((r) => setTimeout(r, 3000));
    return route.fallback();
  });
  const id = await newConversation(page);
  createdConversations.push(id);

  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
  await composer.fill(`只回复这一个词：${tag}。不要调用任何工具。`);
  const send = page.getByRole("button", { name: "Send", exact: true });
  // 历史加载中：不能发送
  await expect(send).toBeDisabled();
  await expect(send).toBeEnabled({ timeout: 15_000 });
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${id}/messages`),
  );
  await send.click();
  expect((await posted).ok()).toBe(true);

  // 用户气泡在、运行态可见，且历史到达后不被冲掉
  const bubble = page.locator("[data-chat-anchor]").filter({ hasText: tag });
  await expect(bubble).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  await expect(bubble).toBeVisible();
});

test("selected model and thinking level are stored on the conversation", async ({ page }) => {
  test.setTimeout(300_000);
  const model = "google-genai:gemini-3.5-flash-lite";
  const tag = `MODEL-${uniqueTag()}`;
  const id = await openNewConversation(page);

  const modelButton = page.getByTestId("model-switcher");
  await modelButton.click();
  await page.getByRole("option").filter({ hasText: "gemini-3.5-flash-lite" }).click();
  await expect(modelButton).toHaveText(/gemini-3\.5-flash-lite/);

  const thinking = page.getByRole("button", { name: "Thinking depth" });
  await thinking.click();
  await page
    .getByRole("listbox", { name: "Thinking depth" })
    .getByRole("option")
    .filter({ hasText: "Brief thinking" })
    .click();
  await expect(thinking).toHaveText(/Low/);

  await sendMessage(page, id, `只回复这一个词：${tag}。不要调用任何工具。`);
  const idle = await waitConversationIdle(page, id, 240_000);
  expect(idle.status).toBe("done");
  const done = await getChatConversation(page, id);
  expect(done.model).toBe(model);
  expect(done.thinkingLevel).toBe("low");
  expect(replyText(done)).toContain(tag);
});

/** 让 agent 调一次 send_email；收件人是保留域 example.test（工具本身也只是 demo，不外发）。 */
function emailPrompt(subject: string, after: string): string {
  return (
    `调用一次 send_email 工具：to 填 e2e-chat@example.test，subject 填 ${subject}，body 填 hello。` +
    `只调用这一次，不要调用其它工具，不要先问我。${after}`
  );
}

test("approval: approve send_email and the turn finishes", async ({ page }) => {
  test.setTimeout(300_000);
  const subject = `SUBJ-${uniqueTag()}`;
  const doneTag = `SENT-${uniqueTag()}`;
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    emailPrompt(subject, `拿到工具结果后只回复这一个词：${doneTag}。`),
  );

  // 审批面板：工具名 + 参数，带批准 / 拒绝
  // PromptPanel 外壳：同时包含标题与决策按钮的最内层 div
  const panel = page
    .locator("div")
    .filter({ has: page.getByText("Needs your sign-off", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await expect(page.getByText("Needs your sign-off", { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(panel.locator("code").getByText("send_email", { exact: true })).toBeVisible();
  await expect(panel.getByText(subject, { exact: true })).toBeVisible();
  expect((await getConversation(page, id)).status).toBe("waiting_approval");

  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Needs your sign-off", { exact: true })).toBeHidden();

  const done = await waitConversationIdle(page, id, 180_000);
  expect(done.status).toBe("done");
  // 工具真正执行了（demo 工具固定返回 sent:true + 主题）
  const results = toolResults(done, "send_email").map(contentText).join("\n");
  expect(results).toContain('\\"sent\\":true');
  expect(results).toContain(subject);
  expect(replyText(done, lastSeq(done, "control_request"))).toContain(doneTag);
});

test("approval: reject send_email and the turn still finishes", async ({ page }) => {
  test.setTimeout(300_000);
  const subject = `SUBJ-${uniqueTag()}`;
  const rejectTag = `REJECTED-${uniqueTag()}`;
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    emailPrompt(
      subject,
      `如果这次调用被拒绝，不要重试、不要再调用任何工具，只回复这一个词：${rejectTag}。`,
    ),
  );

  await expect(page.getByText("Needs your sign-off", { exact: true })).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Needs your sign-off", { exact: true })).toBeHidden();

  const done = await waitConversationIdle(page, id, 180_000);
  expect(done.status).toBe("done");
  // 工具没执行：没有 sent:true 的结果
  const results = toolResults(done, "send_email").map(contentText).join("\n");
  expect(results).not.toContain('\\"sent\\":true');
  expect(replyText(done, lastSeq(done, "control_request"))).toContain(rejectTag);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("ask_user: pick an option and the agent uses the answer", async ({ page }) => {
  test.setTimeout(300_000);
  const t = uniqueTag();
  const [alpha, beta, gamma] = [`ALPHA-${t}`, `BETA-${t}`, `GAMMA-${t}`];
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    `调用一次 ask_user 工具问我一个单选问题：question 填「选哪个？」，header 填「选择」，` +
      `options 的 label 依次是 ${alpha}、${beta}、${gamma}，suggested 填 ${alpha}。` +
      `不要调用其它工具。拿到我的回答后，只回复「CHOSEN=」加我选中的那个 label，不要加其它文字。`,
  );

  await expect(page.getByText("Spark 想确认几件事", { exact: true })).toBeVisible({ timeout: 180_000 });
  // 建议答案默认预选；改选一个非建议项，证明提交的是用户的选择
  await expect(page.getByRole("radio", { name: alpha })).toBeChecked();
  await page.getByRole("radio", { name: beta }).click();
  await expect(page.getByRole("radio", { name: beta })).toBeChecked();
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(page.getByText("Spark 想确认几件事", { exact: true })).toBeHidden();

  const done = await waitConversationIdle(page, id, 180_000);
  expect(done.status).toBe("done");
  const answer = toolResults(done, "ask_user").map(contentText).join("\n");
  expect(answer).toContain(beta);
  const reply = replyText(done, lastSeq(done, "tool_end"));
  expect(reply).toContain(beta);
  expect(reply).not.toContain(alpha);
  expect(reply).not.toContain(gamma);
});

test("stop a running turn", async ({ page }) => {
  test.setTimeout(300_000);
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    "写一篇 3000 字的长篇故事，讲一个灯塔看守人的一生。不要调用任何工具，直接开始写。",
  );
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  // 等真正跑起来（worker 已接手）再停，测的是运行中的中止而不是排队取消
  await expect
    .poll(async () => (await getConversation(page, id)).status, { timeout: 180_000 })
    .toBe("running");
  await stop.click();

  const stopped = await waitConversationIdle(page, id, 60_000);
  expect(stopped.status).toBe("stopped");
  await expect(stop).toBeHidden();
  await expect(page.getByText(/^Stopped after /)).toBeVisible();
  // 界面恢复可发送
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
  await expect(composer).toBeEnabled();
  await composer.fill("hi");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  // 停止是终态：稍后也不会被 worker 改回 done
  await page.waitForTimeout(3_000);
  expect((await getConversation(page, id)).status).toBe("stopped");
});

test("task plan shows three todos completed and token usage is non-zero", async ({ page }) => {
  test.setTimeout(300_000);
  const t = uniqueTag();
  const steps = [`STEP1-${t}`, `STEP2-${t}`, `STEP3-${t}`];
  const doneTag = `PLAN-DONE-${t}`;
  const id = await openNewConversation(page);

  await sendMessage(
    page,
    id,
    `先用 write_todos 列出恰好 3 个待办，内容依次就是 ${steps.join("、")}（原样照抄，不加别的字）。` +
      `然后逐个把它们标记为 completed（每完成一个就再调用一次 write_todos 更新状态），` +
      `最后一次 write_todos 必须三个都是 completed。除 write_todos 外不要调用任何工具。` +
      `全部完成后只回复这一个词：${doneTag}。`,
  );

  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  expect(replyText(done)).toContain(doneTag);

  // 计划面板：3/3（全部完成时默认收起），展开后三步都在、都划掉
  const planToggle = page.getByRole("button", { name: /Game plan/ });
  await expect(planToggle).toContainText("3/3");
  await expect(planToggle).toHaveAttribute("aria-expanded", "false");
  await planToggle.click();
  for (const step of steps) {
    const item = page.getByRole("listitem").filter({ hasText: step });
    await expect(item).toBeVisible();
    await expect(item.locator("span.line-through")).toHaveText(step);
  }

  // token 徽标非 0（运行期由 token_usage 事件更新，结束后由会话 totalTokens 兜底）
  expect(done.totalTokens).toBeGreaterThan(0);
  const badge = page.getByTitle("Total tokens for this conversation (click for the breakdown)");
  await expect(badge).toHaveText(/^[1-9][\d,]* tokens$/);
});

test("attach an image: upload, then shown on the sent message", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = `ATTACH-${uniqueTag()}`;
  const filename = `e2e-${tag.toLowerCase()}.png`;
  const id = await openNewConversation(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: solidPng(320, 320, [64, 128, 192]),
  });
  // 输入框附件条：出现缩略图，传完后移除按钮在、发送可用
  const composerThumb = page.getByRole("img", { name: filename });
  await expect(composerThumb).toBeVisible();
  await expect(page.getByRole("button", { name: `Remove ${filename}` })).toBeVisible();
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(
    `只回复这一个词：${tag}。不要调用任何工具，不要生成任何图片。`,
  );
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 60_000 });
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${id}/messages`),
  );
  await send.click();
  expect((await posted).ok()).toBe(true);

  // 用户消息上方的附件：CDN 地址的图片
  await expect(page.getByRole("button", { name: `Remove ${filename}` })).toHaveCount(0);
  const sentImage = page.getByRole("link", { name: filename }).getByRole("img", { name: filename });
  await expect(sentImage).toBeVisible();
  await expect(sentImage).toHaveAttribute("src", /^https?:\/\//);

  const done = await waitConversationIdle(page, id, 240_000);
  expect(done.status).toBe("done");
  const userMsg = done.messages.find((m) => m.role === "user" && contentText(m).includes(filename));
  expect(userMsg, "user message carries the attachment").toBeDefined();
  // 没有触发生图
  expect(toolResults(done, "generate_image")).toHaveLength(0);
});
