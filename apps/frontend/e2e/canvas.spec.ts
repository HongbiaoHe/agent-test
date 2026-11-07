import { expect, type Locator, type Page, test } from "@playwright/test";

import type { CanvasMessage, CanvasSnapshot } from "@/lib/api";

import { apiOk, loggedInAs, uniqueTag } from "./helpers";
import {
  blockGenerationRequests,
  chatPanel,
  composer,
  createCanvas,
  expectNoGeneration,
  flowEdge,
  flowNode,
  getCanvas,
  getCanvasMessages,
  listCanvases,
  openCanvas,
  resetCanvas,
  waitCanvasReady,
  waitCanvasSettled,
} from "./helpers/canvas";

// 画布：列表（新建 / 改名）、手动搭结构（增删节点与连线、改提示词与模型参数）、
// agent 搭工作流（真实模型）、审批模式切换。
//
// 硬约束：本文件的用例一律不产生任何生成任务。
//  - 不点卡片上的 Generate / Merge / Retry；浏览器里这几个接口被 page.route 直接 abort（见 blockGenerationRequests），
//    万一误触也到不了后端，且用例会失败。
//  - 画布一律以 approvalMode=review 开测：agent 想调 generate_media_node 会先停下等审批，用例一律拒绝。
//  - afterEach 对本条建的每块画布断言：GET /conversations/:canvasId/media 为空、节点 mediaGenerationId / mediaStatus 全为 null。
//
// 画布没有删除功能（后端无 DELETE /canvas/:id，列表页也没有删除入口），清理只能做到：
// 停掉在跑的、审批模式恢复 review、删光节点；画布行留在本测试账号下。见文末 fixme 用例。

loggedInAs("e2e-web-canvas@example.test");

// 宽一点：右侧对话面板（384px）打开时，画布左侧仍有足够的空白放两张节点卡
test.use({ viewport: { width: 1600, height: 1000 } });

/** 本条用例建的画布（afterEach 断言无生成并清理）。 */
let createdCanvases: string[] = [];
/** 被拦下的生成请求（应始终为空）。 */
let blockedGenerations: string[] = [];

test.beforeEach(async ({ page }) => {
  createdCanvases = [];
  blockedGenerations = await blockGenerationRequests(page);
});

test.afterEach(async ({ page }) => {
  for (const id of createdCanvases) {
    await resetCanvas(page, id);
    await expectNoGeneration(page, id);
  }
  expect(blockedGenerations, "generation requests sent from the page").toEqual([]);
});

/** 等快照里出现一个不在 known 里的节点，返回它（右键建节点后用来拿服务端分配的 id）。 */
async function waitNewNode(
  page: Page,
  id: string,
  known: string[],
): Promise<CanvasSnapshot["nodes"][number]> {
  let found: CanvasSnapshot["nodes"][number] | undefined;
  await expect
    .poll(async () => {
      found = (await getCanvas(page, id)).nodes.find((n) => !known.includes(n.id));
      return found?.id ?? null;
    })
    .not.toBeNull();
  if (!found) throw new Error("unreachable: poll resolved without a node");
  return found;
}

/** 在画布空白处 (x, y) 右键 → 「Add node」菜单里选一种类型，返回新节点。 */
async function addNodeAt(
  page: Page,
  id: string,
  x: number,
  y: number,
  typeLabel: "Image" | "Video",
): Promise<CanvasSnapshot["nodes"][number]> {
  const known = (await getCanvas(page, id)).nodes.map((n) => n.id);
  await page.mouse.click(x, y, { button: "right" });
  const menu = page.getByText("Add node", { exact: true }).locator("..");
  await expect(menu).toBeVisible();
  await menu
    .getByRole("button")
    .filter({ has: page.getByText(typeLabel, { exact: true }) })
    .click();
  const node = await waitNewNode(page, id, known);
  await expect(flowNode(page, node.id)).toBeVisible();
  return node;
}

/** 点一下节点卡片：选中它，提示词面板（composer）浮出。 */
async function selectNode(page: Page, nodeId: string): Promise<Locator> {
  await flowNode(page, nodeId).click();
  const panel = composer(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-id", nodeId);
  return panel;
}

/** 收起提示词面板（取消选中），等它消失。 */
async function collapseComposer(page: Page): Promise<void> {
  await composer(page).getByRole("button", { name: "Collapse" }).click();
  await expect(composer(page)).toHaveCount(0);
}

async function expectNodeField<K extends keyof CanvasSnapshot["nodes"][number]>(
  page: Page,
  id: string,
  nodeId: string,
  key: K,
): Promise<CanvasSnapshot["nodes"][number][K]> {
  const snap = await getCanvas(page, id);
  const node = snap.nodes.find((n) => n.id === nodeId);
  expect(node, `node ${nodeId}`).toBeDefined();
  if (!node) throw new Error("unreachable");
  return node[key];
}

/** 等元素位置稳定（连续两次取到同一个包围盒），返回它：首个节点落地后的 fitView 会挪动视口。 */
async function stableBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let prev = "";
  await expect
    .poll(
      async () => {
        const cur = JSON.stringify(await locator.boundingBox());
        const same = cur === prev && cur !== "null";
        prev = cur;
        return same;
      },
      { intervals: [300] },
    )
    .toBe(true);
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

/** control_request 消息里挂起的工具名（审批 / 提问），给报告用。 */
function approvalTools(messages: CanvasMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (m.type !== "control_request") continue;
    const c = m.content;
    if (typeof c !== "object" || c === null || !("actionRequests" in c)) continue;
    const reqs = c.actionRequests;
    if (!Array.isArray(reqs)) continue;
    for (const r of reqs) {
      if (typeof r === "object" && r !== null && "name" in r && typeof r.name === "string") {
        names.push(r.name);
      }
    }
  }
  return names;
}

test("canvas list: create, rename in the editor and the list, reopen", async ({ page }) => {
  const title = `E2E Board ${uniqueTag()}`;
  const renamed = `E2E Renamed ${uniqueTag()}`;

  await page.goto("/canvas-list");
  await expect(page.getByRole("heading", { name: "Canvases" })).toBeVisible();
  await page.getByRole("button", { name: "New canvas" }).first().click();
  await page.waitForURL(/\/canvas\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(id).not.toBe("");
  createdCanvases.push(id);
  await waitCanvasReady(page);

  // 新画布：空、idle、默认审批模式 review
  const fresh = await getCanvas(page, id);
  expect(fresh.status).toBe("idle");
  expect(fresh.approvalMode).toBe("review");
  expect(fresh.nodes).toEqual([]);
  await expect(page.getByText("This canvas is empty")).toBeVisible();

  // 顶栏就地改名
  await page.getByRole("button", { name: fresh.title, exact: true }).click();
  const nameInput = page.getByLabel("Canvas name");
  await nameInput.fill(title);
  await nameInput.press("Enter");
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect.poll(async () => (await getCanvas(page, id)).title).toBe(title);

  // 回列表：能看到它（新建的排在最前）
  await page.getByRole("button", { name: "Back to canvases" }).click();
  await page.waitForURL(/\/canvas-list$/);
  const row = page.locator("li").filter({ hasText: title });
  await expect(row).toBeVisible();
  expect((await listCanvases(page)).find((c) => c.id === id)?.title).toBe(title);

  // 列表里再改一次名
  await row.hover();
  await page.getByRole("button", { name: `Rename ${title}`, exact: true }).click();
  const listInput = page.getByLabel("Canvas name");
  await listInput.fill(renamed);
  await listInput.press("Enter");
  const renamedRow = page.locator("li").filter({ hasText: renamed });
  await expect(renamedRow).toBeVisible();
  await expect.poll(async () => (await getCanvas(page, id)).title).toBe(renamed);

  // 点行进入编辑页，顶栏是新名字
  await renamedRow.getByRole("button").first().click();
  await page.waitForURL(new RegExp(`/canvas/${id}$`));
  await waitCanvasReady(page);
  await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();
});

test("build structure by hand: nodes, prompts, model settings, edge; survives reload", async ({
  page,
}) => {
  const tag = uniqueTag();
  const imagePrompt = `E2E a ginger cat on a windowsill ${tag}`;
  const videoPrompt = `E2E the cat jumps down ${tag}`;
  const id = await createCanvas(page, `E2E Manual ${tag}`);
  createdCanvases.push(id);
  expect((await getCanvas(page, id)).approvalMode).toBe("review");
  await openCanvas(page, id, false);

  // 右键空白处建生图节点；首个节点落地后画布会 fitView 一次，所以第二个的落点按第一张卡的位置算
  const image = await addNodeAt(page, id, 500, 500, "Image");
  expect(image.type).toBe("image_gen");
  const imageCard = flowNode(page, image.id);
  const box = await stableBox(imageCard);
  const video = await addNodeAt(page, id, box.x + box.width + 260, box.y + box.height / 2, "Video");
  expect(video.type).toBe("video_gen");

  // 生图节点：写提示词、换模型（只改设置，不点 Generate）
  let panel = await selectNode(page, image.id);
  await panel.getByLabel("Prompt").fill(imagePrompt);
  await expect.poll(() => expectNodeField(page, id, image.id, "prompt")).toBe(imagePrompt);
  await expect(panel.getByRole("button", { name: "Generate" })).toBeVisible();
  await panel.getByTitle("Model").click();
  await page.getByRole("button", { name: "Seedream 5.0 lite", exact: true }).click();
  await expect.poll(() => expectNodeField(page, id, image.id, "mediaModel")).toBe("seedream-5-lite");
  expect(await expectNodeField(page, id, image.id, "mediaChannel")).toBe("byteplus");
  await expect(panel.getByTitle("Model")).toHaveText("Seedream 5.0 lite");
  await collapseComposer(page);

  // 生视频节点：写提示词、改时长档位
  panel = await selectNode(page, video.id);
  await panel.getByLabel("Prompt").fill(videoPrompt);
  await expect.poll(() => expectNodeField(page, id, video.id, "prompt")).toBe(videoPrompt);
  await panel.getByTitle("Generation settings").click();
  await page.getByRole("radio", { name: "5s", exact: true }).click();
  await expect
    .poll(async () => (await expectNodeField(page, id, video.id, "mediaParams"))?.duration ?? null)
    .toBe("5");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "5s", exact: true })).toHaveCount(0);
  if ((await composer(page).count()) > 0) await collapseComposer(page);

  // 从生图节点的出口拖到生视频节点的入口
  const from = await imageCard.locator(".react-flow__handle.source").boundingBox();
  const to = await flowNode(page, video.id).locator(".react-flow__handle.target").boundingBox();
  if (!from || !to) throw new Error("handles not found");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y + 40, { steps: 8 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await getCanvas(page, id)).edges.length).toBe(1);
  const built = await getCanvas(page, id);
  const edge = built.edges[0];
  expect({ source: edge.source, target: edge.target }).toEqual({
    source: image.id,
    target: video.id,
  });
  await expect(flowEdge(page, edge.id)).toBeVisible();

  // 刷新：节点、连线、提示词、模型设置都还在，且与接口一致
  await page.reload();
  await waitCanvasReady(page);
  const snap = await getCanvas(page, id);
  expect(snap.nodes.map((n) => n.id).sort()).toEqual([image.id, video.id].sort());
  expect(snap.edges.map((e) => e.id)).toEqual([edge.id]);
  await expect(page.locator(".react-flow__node")).toHaveCount(snap.nodes.length);
  await expect(page.locator(".react-flow__edge")).toHaveCount(snap.edges.length);
  for (const n of snap.nodes) await expect(flowNode(page, n.id)).toBeVisible();
  await expect(flowEdge(page, edge.id)).toBeVisible();
  const savedImage = snap.nodes.find((n) => n.id === image.id);
  const savedVideo = snap.nodes.find((n) => n.id === video.id);
  expect(savedImage).toMatchObject({
    type: "image_gen",
    prompt: imagePrompt,
    mediaChannel: "byteplus",
    mediaModel: "seedream-5-lite",
  });
  expect(savedVideo).toMatchObject({ type: "video_gen", prompt: videoPrompt });
  expect(savedVideo?.mediaParams?.duration).toBe("5");

  panel = await selectNode(page, image.id);
  await expect(panel.getByLabel("Prompt")).toHaveValue(imagePrompt);
  await expect(panel.getByTitle("Model")).toHaveText("Seedream 5.0 lite");
  await collapseComposer(page);
  panel = await selectNode(page, video.id);
  await expect(panel.getByLabel("Prompt")).toHaveValue(videoPrompt);
  await expect(panel.getByTitle("Generation settings")).toContainText("5s");
  await collapseComposer(page);

  // 删连线：点选连线后按 Delete
  const edgeEl = flowEdge(page, edge.id);
  await edgeEl.dispatchEvent("click");
  await expect(edgeEl).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await getCanvas(page, id)).edges.length).toBe(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  // 删节点：悬停卡片，用卡片上方浮出的操作组里的 Delete（桌面端提示词面板里没有这组操作）
  const videoCard = flowNode(page, video.id);
  await videoCard.hover();
  await videoCard.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(async () => (await getCanvas(page, id)).nodes.map((n) => n.id))
    .toEqual([image.id]);
  await expect(flowNode(page, video.id)).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await expectNoGeneration(page, id);
});

test("agent builds the workflow in review mode without generating", async ({ page }, testInfo) => {
  test.setTimeout(540_000);
  const tag = `E2EMARK${uniqueTag()}`;
  const id = await createCanvas(page, `E2E Agent ${tag}`);
  createdCanvases.push(id);
  expect((await getCanvas(page, id)).approvalMode).toBe("review");
  await openCanvas(page, id, true);

  const chat = chatPanel(page);
  await expect(chat.getByRole("button", { name: "Approval mode" })).toHaveText("Review");

  const goal =
    "只搭结构，不要触发任何生成：不要调用 generate_media_node 或 merge_video_node，也不需要问我问题。" +
    `1) 建一个生图节点（image_gen），提示词写：一只橘猫坐在窗台上 ${tag}。` +
    "2) 再建一个生视频节点（video_gen），提示词写：橘猫从窗台跳下。" +
    "3) 把生图节点连到生视频节点。做完这三步就结束，不要做别的。";
  const composerInput = chat.getByPlaceholder("Describe the workflow, or type / for skills");
  await composerInput.fill(goal);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api-backend/canvas/${id}/messages`),
  );
  await composerInput.press("Enter");
  expect((await posted).ok()).toBe(true);
  expect((await getCanvas(page, id)).approvalMode).toBe("review");

  // 等这一轮结束；中途停下来等审批 / 提问就拒绝（审批）或让它按结构继续（提问）
  const deadline = Date.now() + 480_000;
  let snap = await waitCanvasSettled(page, id, 480_000);
  while (snap.status === "waiting_approval") {
    const ask = chat.getByText(/^(Agent needs approval|Agent asks)$/);
    await expect(ask).toBeVisible();
    if ((await ask.textContent()) === "Agent needs approval") {
      await chat.getByRole("button", { name: /^Cancel( all)?$/ }).click();
    } else {
      await chat.getByLabel("Your answer").fill("按你的判断继续，只搭结构，不要触发任何生成。");
      await chat.getByRole("button", { name: "Send answer" }).click();
    }
    await expect
      .poll(async () => (await getCanvas(page, id)).status, { timeout: 30_000 })
      .not.toBe("waiting_approval");
    snap = await waitCanvasSettled(page, id, Math.max(deadline - Date.now(), 1_000));
  }
  const approvals = approvalTools(await getCanvasMessages(page, id));
  testInfo.annotations.push({
    type: "approvals",
    description: approvals.length ? approvals.join(", ") : "none",
  });
  expect(snap.status).toBe("done");

  // 画布上：带标记串的生图节点 → 生视频节点 的连线
  const images = snap.nodes.filter((n) => n.type === "image_gen" && n.prompt?.includes(tag));
  const videos = snap.nodes.filter((n) => n.type === "video_gen");
  expect(images.length, JSON.stringify(snap.nodes)).toBeGreaterThanOrEqual(1);
  expect(videos.length, JSON.stringify(snap.nodes)).toBeGreaterThanOrEqual(1);
  const link = snap.edges.find(
    (e) => images.some((n) => n.id === e.source) && videos.some((n) => n.id === e.target),
  );
  expect(link, JSON.stringify(snap.edges)).toBeDefined();
  if (!link) throw new Error("unreachable");
  await expect(flowNode(page, link.source)).toBeVisible();
  await expect(flowNode(page, link.target)).toBeVisible();
  await expect(flowEdge(page, link.id)).toBeVisible();
  expect(snap.approvalMode).toBe("review");

  await expectNoGeneration(page, id);
});

test("approval mode switcher: review ↔ auto is saved with the next message", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await createCanvas(page, `E2E Approval ${uniqueTag()}`);
  createdCanvases.push(id);
  await openCanvas(page, id, true);
  const chat = chatPanel(page);
  const trigger = chat.getByRole("button", { name: "Approval mode" });
  const input = chat.getByPlaceholder("Describe the workflow, or type / for skills");
  await expect(trigger).toHaveText("Review");

  /** 在切换器里选一档；它只改输入框的本地选择，随下一条消息落库。 */
  async function pick(label: "Full autopilot" | "Ask before risky steps", shown: string) {
    await trigger.click();
    await page
      .getByRole("listbox", { name: "Approval mode" })
      .getByRole("option")
      .filter({ hasText: label })
      .click();
    await expect(trigger).toHaveText(shown);
  }

  /** 发一条消息并立刻停掉（worker 开跑前的 gate 会拦下，agent 不做任何事），等画布停稳。 */
  async function sendAndStop(text: string) {
    await input.fill(text);
    const posted = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith(`/api-backend/canvas/${id}/messages`),
    );
    await input.press("Enter");
    expect((await posted).ok()).toBe(true);
    await apiOk(page, `/canvas/${id}/stop`, { method: "POST" });
    const settled = await waitCanvasSettled(page, id);
    expect(settled.status).toBe("stopped");
    await expect(input).toBeEnabled();
  }

  // 切到 auto：只是本地选择，接口里还是 review；发消息时一并落库
  await pick("Full autopilot", "Auto");
  expect((await getCanvas(page, id)).approvalMode).toBe("review");
  await sendAndStop("只回复 OK，不要调用任何工具。");
  expect((await getCanvas(page, id)).approvalMode).toBe("auto");

  // 刷新后切换器按会话值显示 Auto
  await page.reload();
  await waitCanvasReady(page);
  await expect(trigger).toHaveText("Auto");

  // 切回 review，同样随消息落库
  await pick("Ask before risky steps", "Review");
  expect((await getCanvas(page, id)).approvalMode).toBe("auto");
  await sendAndStop("只回复 OK，不要调用任何工具。");
  expect((await getCanvas(page, id)).approvalMode).toBe("review");
  await page.reload();
  await waitCanvasReady(page);
  await expect(trigger).toHaveText("Review");
});

// 画布不能删除：后端 CanvasController 没有 DELETE /canvas/:id，列表页（CanvasGallery）也没有删除入口，
// 只有置顶 / 重命名。功能缺失而非 bug，按期望行为写好、标 fixme 跳过，待产品补上删除后去掉标注。
test.fixme("delete a canvas from the list", async ({ page }) => {
  const title = `E2E Doomed ${uniqueTag()}`;
  const id = await createCanvas(page, title);
  createdCanvases.push(id);
  await page.goto("/canvas-list");
  const row = page.locator("li").filter({ hasText: title });
  await row.hover();
  await page.getByRole("button", { name: `Delete ${title}`, exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await listCanvases(page)).some((c) => c.id === id)).toBe(false);
});
