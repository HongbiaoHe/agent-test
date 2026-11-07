// design 用例专用的工具：设计稿 CRUD / op 接口、轮询 agent 运行状态、编辑器里的面板定位。
import { expect, type Locator, type Page } from "@playwright/test";

import type { DesignMessageRow, DesignSnapshot } from "@/app/design/_lib/api";
import type { DesignOp } from "@agent-test/design-schema";

import { api, apiOk } from "../helpers";

/** 用接口建一份方形空白设计稿。 */
export function createDesign(page: Page, title: string): Promise<DesignSnapshot> {
  return apiOk<DesignSnapshot>(page, "/design", {
    method: "POST",
    body: { title, canvas: { width: 1080, height: 1080, background: "#F4F1EC" } },
  });
}

export function getDesign(page: Page, id: string): Promise<DesignSnapshot> {
  return apiOk<DesignSnapshot>(page, `/design/${id}`);
}

/** 以接口提交一批 op（clientId 随便给一个，不和页面里的编辑器冲突）。 */
export function applyOps(page: Page, id: string, ops: DesignOp[]): Promise<{ revision: number }> {
  return apiOk<{ revision: number }>(page, `/design/${id}/ops`, {
    method: "POST",
    body: { ops, clientId: "e2e" },
  });
}

/** 清理：删设计稿；已被用例自己删掉（404）也算成功。 */
export async function deleteDesign(page: Page, id: string): Promise<void> {
  const res = await api(page, `/design/${id}`, { method: "DELETE" });
  if (res.status === 404) return;
  expect(res.code, `DELETE /design/${id}: ${res.message}`).toBe(0);
}

/** 轮询设计稿的 agent 状态，直到这一轮结束（不再是 running），返回此刻的快照。 */
export async function waitDesignIdle(page: Page, id: string, timeoutMs: number): Promise<DesignSnapshot> {
  await expect
    .poll(async () => (await getDesign(page, id)).status, {
      timeout: timeoutMs,
      intervals: [1_000, 2_000],
    })
    .not.toBe("running");
  return getDesign(page, id);
}

export function designMessages(page: Page, id: string): Promise<DesignMessageRow[]> {
  return apiOk<DesignMessageRow[]>(page, `/design/${id}/messages`);
}

/** agent 这轮调用过的工具名（tool_start 行的 content = { tool_calls: [{ name, … }] }）。 */
export function calledTools(rows: DesignMessageRow[]): string[] {
  return rows
    .filter((r) => r.type === "tool_start")
    .flatMap((r) => {
      const c = r.content;
      if (typeof c !== "object" || c === null || !("tool_calls" in c) || !Array.isArray(c.tool_calls)) {
        return [];
      }
      return c.tool_calls.flatMap((call: unknown) =>
        typeof call === "object" && call !== null && "name" in call && typeof call.name === "string"
          ? [call.name]
          : [],
      );
    });
}

/** 左侧图层面板（标题「图层」所在的 aside）。 */
export function layersPanel(page: Page): Locator {
  return page.locator("aside").filter({ has: page.getByText("图层", { exact: true }) });
}

/** 图层面板里的行：自上而下 = z 序自顶向下（每行都可拖拽排序）。 */
export function layerRows(page: Page): Locator {
  return layersPanel(page).locator("div[draggable]");
}

/** 右侧属性面板（第二个 aside）。 */
export function propertiesPanel(page: Page): Locator {
  return page.locator("aside").nth(1);
}

/** 打开编辑器并等画板（Konva canvas）就绪。 */
export async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/design/${id}`);
  await expect(page.getByLabel("设计稿名称")).toBeVisible();
  await expect(page.locator("main canvas").first()).toBeVisible();
}
