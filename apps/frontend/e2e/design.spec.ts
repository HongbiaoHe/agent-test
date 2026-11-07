import { readFile } from "node:fs/promises";

import { createTextLayer } from "@agent-test/design-schema";
import { expect, test } from "@playwright/test";

import { api, loggedInAs, uniqueTag } from "./helpers";
import { solidPng } from "./helpers/chat";
import {
  applyOps,
  calledTools,
  createDesign,
  deleteDesign,
  designMessages,
  getDesign,
  layerRows,
  openEditor,
  propertiesPanel,
  waitDesignIdle,
} from "./helpers/design";

// 分图层设计：列表（新建 / 改名 / 删除）、编辑器（工具栏加图层、属性面板、图层面板排序 / 隐藏 / 删除、
// 刷新后保留）、agent 停靠面板（真实模型，只加文字图层、不生图）、前端导出（PNG / PSD 下载）。
// 不碰 /layers/:id/generate 与 decompose（会调 aigc 生图）。afterEach 用接口删掉本条建的设计稿。

loggedInAs("e2e-web-design@example.test");

/** 本条用例建的设计稿（afterEach 删掉）。 */
let createdDesigns: string[] = [];

test.beforeEach(() => {
  createdDesigns = [];
});

test.afterEach(async ({ page }) => {
  for (const id of createdDesigns) {
    // agent 还在跑就先停下，再删
    if ((await api<{ status: string }>(page, `/design/${id}`)).data?.status === "running") {
      await api(page, `/design/${id}/stop`, { method: "POST" });
      await waitDesignIdle(page, id, 60_000);
    }
    await deleteDesign(page, id);
  }
});

test("list: create a design, rename it, see it in the list, delete it", async ({ page }) => {
  const title = `E2E Design ${uniqueTag()}`;
  await page.goto("/design");
  await page.getByRole("button", { name: "新建设计" }).click();
  await page.getByRole("menuitem").filter({ hasText: "方形 1:1" }).click();
  await page.waitForURL(/\/design\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  createdDesigns.push(id);

  const created = await getDesign(page, id);
  expect(created.title).toBe("方形 1:1");
  expect(created.document.canvas).toMatchObject({ width: 1080, height: 1080 });

  // 顶栏改名：回车失焦即提交
  const titleInput = page.getByLabel("设计稿名称");
  await expect(titleInput).toHaveValue("方形 1:1");
  const patched = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api-backend/design/${id}`),
  );
  await titleInput.fill(title);
  await titleInput.press("Enter");
  expect((await patched).ok()).toBe(true);
  expect((await getDesign(page, id)).title).toBe(title);

  // 回列表：卡片显示新名字（返回按钮是 Base UI Button 渲染成的链接，role 为 button）
  await page.getByRole("button", { name: "返回设计列表" }).click();
  await page.waitForURL(/\/design$/);
  const cardLink = page.getByRole("link").filter({ hasText: title });
  await expect(cardLink).toBeVisible();
  await expect(cardLink).toContainText("1080×1080 · 0 个图层");

  // 删除：卡片右上角「更多」→ 删除
  const card = page
    .locator("div")
    .filter({ has: cardLink })
    .filter({ has: page.getByRole("button", { name: "更多" }) })
    .last();
  await card.hover();
  await card.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(cardLink).toHaveCount(0);
  expect((await api(page, `/design/${id}`)).status).toBe(404);
});

test("editor: add text and image layers, edit, reorder, hide, delete, persists after reload", async ({
  page,
}) => {
  const tag = uniqueTag();
  const text = `E2E TEXT ${tag}`;
  const imageName = `e2e-rect-${tag.toLowerCase()}`;
  const design = await createDesign(page, `E2E Edit ${tag}`);
  createdDesigns.push(design.id);
  await openEditor(page, design.id);

  // 工具栏「文字」：加一个文字图层并直接进入原地编辑
  await page.getByRole("button", { name: "文字 (T)" }).click();
  const inlineEditor = page.getByRole("textbox", { name: /^编辑文字：/ });
  await expect(inlineEditor).toBeFocused();
  await inlineEditor.fill(text);
  await inlineEditor.press("Escape");
  await expect(inlineEditor).toHaveCount(0);

  // 属性面板（新图层已选中）：文案、颜色、位置
  const props = propertiesPanel(page);
  await expect(props.getByLabel("文案")).toHaveValue(text);
  const color = props.getByLabel("文字颜色色值");
  await color.fill("#C0392B");
  await color.press("Enter");
  await expect(color).toHaveValue("#C0392B");
  const x = props.getByLabel("X", { exact: true });
  await x.fill("120");
  await x.press("Enter");
  const y = props.getByLabel("Y", { exact: true });
  await y.fill("200");
  await y.press("Enter");
  await expect(x).toHaveValue("120");
  await expect(y).toHaveValue("200");

  // 工具栏「上传图片」：一张纯色 PNG 作为矩形图层（文档模型只有 text / image 两种图层，没有形状图层）
  await page.locator('input[type="file"]:not([multiple])').setInputFiles({
    name: `${imageName}.png`,
    mimeType: "image/png",
    buffer: solidPng(240, 120, [40, 90, 160]),
  });

  // 图层面板：自上而下 = 图片（后加）、文字
  const rows = layerRows(page);
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  await expect(rows.nth(0)).toContainText(imageName);
  await expect(rows.nth(1)).toContainText("标题");

  // 拖拽排序：文字拖到图片上方
  await rows.nth(1).dragTo(rows.nth(0));
  await expect(rows.nth(0)).toContainText("标题");
  await expect(rows.nth(1)).toContainText(imageName);

  // 隐藏图片图层
  const imageRow = rows.filter({ hasText: imageName });
  await imageRow.hover();
  await imageRow.getByRole("button", { name: "隐藏" }).click();
  await expect(imageRow.getByRole("button", { name: "显示" })).toBeVisible();

  // 后端文档：底层图片（隐藏、CDN 地址）、顶层文字（文案 / 颜色 / 位置）
  await expect
    .poll(async () => {
      const { layers } = (await getDesign(page, design.id)).document;
      return layers.map((l) =>
        l.type === "text"
          ? { type: l.type, text: l.text, fill: l.fill, x: l.x, y: l.y, visible: l.visible }
          : { type: l.type, name: l.name, visible: l.visible, hasSrc: Boolean(l.src?.startsWith("http")) },
      );
    })
    .toEqual([
      { type: "image", name: imageName, visible: false, hasSrc: true },
      { type: "text", text, fill: "#C0392B", x: 120, y: 200, visible: true },
    ]);

  // 刷新：顺序、隐藏态、文字属性都还在
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("标题");
  await expect(rows.nth(1).getByRole("button", { name: "显示" })).toBeVisible();
  await rows.nth(0).click();
  await expect(props.getByLabel("文案")).toHaveValue(text);
  await expect(props.getByLabel("文字颜色色值")).toHaveValue("#C0392B");
  await expect(props.getByLabel("X", { exact: true })).toHaveValue("120");

  // 删除：选中图片图层按 Delete
  await rows.filter({ hasText: imageName }).click();
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(1);
  await expect
    .poll(async () => (await getDesign(page, design.id)).document.layers.map((l) => l.type))
    .toEqual(["text"]);
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("标题");
});

test("agent dock: the design agent adds a text layer without generating images", async ({ page }) => {
  test.setTimeout(300_000);
  const marker = `E2E-AGENT-${uniqueTag()}`;
  const design = await createDesign(page, `E2E Agent ${uniqueTag()}`);
  createdDesigns.push(design.id);
  await openEditor(page, design.id);

  await page.getByRole("button", { name: /描述你想要的设计/ }).click();
  const input = page.getByPlaceholder(/^说说要做什么/);
  await expect(input).toBeFocused();
  await input.fill(
    `在画布中间加一个文字图层，文字内容就是 ${marker}（原样照抄，不要加别的字）。` +
      "只调用一次 add_layers，只加这一个 text 图层，不要加任何 image 图层。" +
      "不要生成、重新生成或拆分任何图片（不要调用 generate_layer_image、decompose_layer），" +
      "也不要调用 render_preview。加完后用一句话回复。",
  );
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api-backend/design/${design.id}/messages`),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await posted).ok()).toBe(true);

  const done = await waitDesignIdle(page, design.id, 240_000);
  expect(done.status).toBe("done");
  const textLayers = done.document.layers.filter((l) => l.type === "text");
  expect(textLayers.map((l) => l.text).join("\n")).toContain(marker);
  // 没有任何图片图层、没有调用生图 / 拆层
  expect(done.document.layers.filter((l) => l.type === "image")).toHaveLength(0);
  const tools = calledTools(await designMessages(page, design.id));
  expect(tools).toContain("add_layers");
  expect(tools).not.toContain("generate_layer_image");
  expect(tools).not.toContain("decompose_layer");

  // 界面：图层面板实时出现这个图层，选中后属性面板里是这段文案
  const rows = layerRows(page);
  await expect(rows).toHaveCount(done.document.layers.length);
  await rows.first().click();
  await expect(propertiesPanel(page).getByLabel("文案")).toHaveValue(new RegExp(marker));
});

test("export: PNG and PSD are rendered in the browser and downloaded", async ({ page }, testInfo) => {
  const title = `E2E Export ${uniqueTag()}`;
  const design = await createDesign(page, title);
  createdDesigns.push(design.id);
  await applyOps(page, design.id, [
    {
      type: "add_layers",
      layers: [
        createTextLayer({ x: 140, y: 480, width: 800, height: 96, fontSize: 80, text: "Export me", name: "标题" }),
      ],
    },
  ]);
  await openEditor(page, design.id);
  await expect(layerRows(page)).toHaveCount(1);

  await page.getByRole("button", { name: "导出", exact: true }).click();
  // 默认 PNG @2x
  await expect(page.getByText("2160 × 2160 px")).toBeVisible();
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PNG" }).click();
  const png = await pngDownload;
  expect(png.suggestedFilename()).toBe(`${title}@2x.png`);
  const pngPath = testInfo.outputPath("export.png");
  await png.saveAs(pngPath);
  const pngBytes = await readFile(pngPath);
  expect(pngBytes.length).toBeGreaterThan(0);
  expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // IHDR 里的宽高 = 画布 × 2
  expect(pngBytes.readUInt32BE(16)).toBe(2160);
  expect(pngBytes.readUInt32BE(20)).toBe(2160);

  // PSD（分层）
  await page.getByRole("button", { name: /^PSD/ }).click();
  const psdDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PSD" }).click();
  const psd = await psdDownload;
  expect(psd.suggestedFilename()).toBe(`${title}.psd`);
  const psdPath = testInfo.outputPath("export.psd");
  await psd.saveAs(psdPath);
  const psdBytes = await readFile(psdPath);
  expect(psdBytes.length).toBeGreaterThan(0);
  expect(psdBytes.subarray(0, 4).toString("ascii")).toBe("8BPS");
});
