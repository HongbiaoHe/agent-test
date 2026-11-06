import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

import type { McpServer as McpServerView } from "@/components/mcp";

import {
  apiOk,
  assistantText,
  type ConversationDetail,
  deleteConversation,
  loggedInAs,
  uniqueTag,
  waitConversationIdle,
} from "./helpers";
import {
  deleteAllConnectors,
  getConnector,
  type LocalMcpServer,
  listConnectors,
  type McpMarkers,
  startMcpServer,
} from "./helpers/mcp";

// MCP 连接器：设置页添加 / 连接 / 工具权限 / 删除 + 会话里调用工具（真实模型）、审批、MCP App 卡片。
// 本地 MCP server 在测试进程里起（helpers/mcp.ts），整个文件共用一个；afterAll 关掉。
// 每条用例 afterEach 用接口删掉连接器和本条建的会话。

loggedInAs("e2e-web-skills@example.test");

/** 连接器名：也决定模型侧的工具前缀（slug `e2e` → `e2e__get_secret`）。 */
const CONNECTOR = "e2e";

const markers: McpMarkers = {
  secret: `MCP-SECRET-${uniqueTag()}`,
  danger: `MCP-DANGER-${uniqueTag()}`,
  card: `MCP-CARD-${uniqueTag()}`,
};

let mcp: LocalMcpServer;
let createdConversations: string[] = [];

test.beforeAll(async () => {
  mcp = await startMcpServer(markers);
});

test.afterAll(async () => {
  await mcp.close();
});

test.beforeEach(async ({ page }) => {
  createdConversations = [];
  for (const k of Object.keys(mcp.calls)) delete mcp.calls[k];
  await deleteAllConnectors(page);
});

test.afterEach(async ({ page }) => {
  for (const id of createdConversations) await deleteConversation(page, id);
  await deleteAllConnectors(page);
});

/** 用接口添加并连接本地 server（会话类用例的前置条件）。 */
async function addConnector(page: Page): Promise<McpServerView> {
  const res = await apiOk<{ status: string; server: McpServerView }>(page, "/mcp/servers", {
    method: "POST",
    body: { url: mcp.url, name: CONNECTOR },
  });
  expect(res.status).toBe("connected");
  return res.server;
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

const toolStartContent = z.object({ tool_calls: z.array(z.object({ name: z.string() })) });

/** 会话里模型调用某个工具的次数（tool_start 消息的 content.tool_calls，name 是模型侧工具名）。 */
function toolCallCount(conv: ConversationDetail, toolName: string): number {
  return conv.messages
    .filter((m) => m.type === "tool_start")
    .flatMap((m) => toolStartContent.safeParse(m.content).data?.tool_calls ?? [])
    .filter((c) => c.name === toolName).length;
}

/** 工具结果（tool_end）里拼起来的文本。 */
function toolResultText(conv: ConversationDetail): string {
  return conv.messages
    .filter((m) => m.type === "tool_end")
    .map((m) => JSON.stringify(m.content))
    .join("\n");
}

test("add a connector, set a tool to disabled, then remove it", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Add connector" }).click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector" });
  await dialog.getByPlaceholder("Optional — defaults to the server's own name").fill(CONNECTOR);
  await dialog.getByPlaceholder("https://example.com/mcp").fill(mcp.url);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // 列表卡片：已连接 + 3 个工具
  const card = page.getByRole("button", { name: `Open ${CONNECTOR} details`, exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card).toContainText(`${mcp.url} · 3 tools`);
  const [server] = await listConnectors(page);
  expect(server.status).toBe("connected");
  expect(server.tools.map((t) => [t.name, t.permission]).sort()).toEqual([
    ["danger_op", "ask"],
    ["get_secret", "allow"],
    ["show_card", "allow"],
  ]);

  // 详情：工具列表与默认权限；把 get_secret 改成 Disabled
  await card.click();
  const sheet = page.getByRole("dialog").filter({ hasText: "Tools (3)" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("combobox", { name: "Permission for danger_op" })).toContainText(
    "Needs approval",
  );
  const secretPerm = sheet.getByRole("combobox", { name: "Permission for get_secret" });
  await expect(secretPerm).toContainText("Always allow");
  await secretPerm.click();
  await page.getByRole("option", { name: "Disabled", exact: true }).click();
  await expect(secretPerm).toContainText("Disabled");
  await expect
    .poll(async () => (await getConnector(page, server.id)).tools.find((t) => t.name === "get_secret")?.permission)
    .toBe("deny");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // 生效：模型的工具表里没有 e2e__get_secret——会话里让它调用，既没有调用记录，server 也没被调到
  const id = await openNewConversation(page);
  await sendMessage(
    page,
    id,
    `如果你有名为 ${CONNECTOR}__get_secret 的工具就调用它并原样告诉我结果；没有这个工具就只回复「NO-TOOL」，不要调用其它任何工具。`,
  );
  const conv = await waitConversationIdle(page, id, 180_000);
  expect(conv.status).toBe("done");
  expect(toolCallCount(conv, `${CONNECTOR}__get_secret`)).toBe(0);
  expect(mcp.calls.get_secret ?? 0).toBe(0);
  expect(assistantText(conv)).not.toContain(markers.secret);

  // 删除：详情里 Remove → 确认 → 列表回到空态
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: `Open ${CONNECTOR} details`, exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${CONNECTOR}?` });
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("button", { name: `Open ${CONNECTOR} details` })).toHaveCount(0);
  await expect(page.getByText("No connectors yet", { exact: false })).toBeVisible();
  expect(await listConnectors(page)).toHaveLength(0);
});

test("agent calls a read-only MCP tool", async ({ page }) => {
  test.setTimeout(300_000);
  await addConnector(page);
  const id = await openNewConversation(page);
  await sendMessage(
    page,
    id,
    `调用 ${CONNECTOR} 连接器的 get_secret 工具，把它返回的内容原样告诉我。`,
  );
  const conv = await waitConversationIdle(page, id, 180_000);
  expect(conv.status).toBe("done");
  expect(toolCallCount(conv, `${CONNECTOR}__get_secret`)).toBeGreaterThan(0);
  expect(mcp.calls.get_secret).toBeGreaterThan(0);
  expect(assistantText(conv)).toContain(markers.secret);
  await expect(page.getByText(markers.secret).first()).toBeVisible();
});

test("a non-read-only MCP tool waits for approval, then runs", async ({ page }) => {
  test.setTimeout(300_000);
  await addConnector(page);
  const id = await openNewConversation(page);
  await sendMessage(
    page,
    id,
    `调用 ${CONNECTOR} 连接器的 danger_op 工具（不需要参数），然后把它返回的内容原样告诉我。`,
  );

  // 停在审批：面板显示工具名，server 还没被调用
  const waiting = await waitConversationIdle(page, id, 180_000);
  expect(waiting.status).toBe("waiting_approval");
  // 审批面板 = 同时含标题和 Approve 按钮的最内层 div（祖先在文档序里排在前面，取 last）
  const panel = page
    .locator("div")
    .filter({ hasText: "Needs your sign-off" })
    .filter({ has: page.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await expect(panel).toBeVisible();
  await expect(panel.locator("code").getByText(`${CONNECTOR}__danger_op`, { exact: true })).toBeVisible();
  expect(mcp.calls.danger_op ?? 0).toBe(0);

  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Needs your sign-off", { exact: true })).toBeHidden();
  const done = await waitConversationIdle(page, id, 180_000);
  expect(done.status).toBe("done");
  expect(mcp.calls.danger_op).toBe(1);
  expect(toolResultText(done)).toContain(markers.danger);
  expect(assistantText(done)).toContain(markers.danger);
});

test("MCP App card renders in the sandbox origin and calls back a tool", async ({ page }) => {
  test.setTimeout(300_000);
  await addConnector(page);
  const id = await openNewConversation(page);
  // 回归：卡片在实时流里出现后，后续每个流式事件都会重折叠线程、产出新的 app 对象；
  // 旧代码的 bridge effect 依赖它，反复拆建 bridge 并重载代理 iframe，卡片停在空白。
  // 整轮里代理页只应加载一次。
  const sandboxLoads: string[] = [];
  page.on("framenavigated", (f) => {
    if (/^http:\/\/m-[a-f0-9]{16}\./.test(f.url())) sandboxLoads.push(f.url());
  });
  await sendMessage(
    page,
    id,
    `调用 ${CONNECTOR} 连接器的 show_card 工具，然后只回复「卡片已展示」。`,
  );
  const conv = await waitConversationIdle(page, id, 180_000);
  expect(conv.status).toBe("done");
  expect(toolCallCount(conv, `${CONNECTOR}__show_card`)).toBeGreaterThan(0);

  // 外层代理 iframe（title「<连接器名> app」）在后端 m-<hash> 子域名上；内层是 View
  const outer = page.locator(`iframe[title="${CONNECTOR} app"]`);
  await expect(outer).toHaveAttribute("src", /^http:\/\/m-[a-f0-9]{16}\.localhost:\d+\/$/, {
    timeout: 30_000,
  });
  const view = page.frameLocator(`iframe[title="${CONNECTOR} app"]`).frameLocator("iframe");
  await expect(view.getByText(`APP-RESULT:${markers.card}`)).toBeVisible({ timeout: 30_000 });
  // 卡片自己回调 get_secret（经后端 /mcp/apps/call-tool 代理到 server）
  await expect(view.getByText(`APP-CALL:${markers.secret}`)).toBeVisible({ timeout: 30_000 });
  expect(mcp.calls.get_secret).toBeGreaterThan(0);
  expect(sandboxLoads).toHaveLength(1);
});
