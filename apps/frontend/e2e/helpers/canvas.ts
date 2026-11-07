// canvas 用例专用工具：画布接口（快照 / 列表 / 消息 / 生成记录）、页面打开与节点定位、
// 「不产生任何生成任务」的拦截与断言。
import { expect, type Locator, type Page } from "@playwright/test";

import type {
  CanvasApprovalMode,
  CanvasListItem,
  CanvasMessage,
  CanvasSnapshot,
  MediaGeneration,
} from "@/lib/api";

import { api, apiOk } from "../helpers";

/** 画布还在跑（agent 占用中）的状态：镜像后端 canvas.service 的 BUSY_STATUSES。 */
const BUSY = ["queued", "running", "waiting_approval"];

// ---- 接口 ----

export function getCanvas(page: Page, id: string): Promise<CanvasSnapshot> {
  return apiOk<CanvasSnapshot>(page, `/canvas/${id}`);
}

export async function listCanvases(page: Page): Promise<CanvasListItem[]> {
  const res = await apiOk<{ items: CanvasListItem[] }>(page, "/canvas?limit=100");
  return res.items;
}

export function getCanvasMessages(page: Page, id: string): Promise<CanvasMessage[]> {
  return apiOk<CanvasMessage[]>(page, `/canvas/${id}/messages`);
}

/**
 * 用接口建一块空画布（idle，不跑 agent）。审批模式显式给 review：
 * 万一 agent 想调 generate_media_node，也会先停下来等审批。
 */
export async function createCanvas(
  page: Page,
  title: string,
  approvalMode: CanvasApprovalMode = "review",
): Promise<string> {
  const { sessionId } = await apiOk<{ sessionId: string }>(page, "/canvas", {
    method: "POST",
    body: { title, approvalMode },
  });
  return sessionId;
}

/**
 * 画布名下的全部生成记录：画布的生成（手动 Generate 与 agent 的 generate_media_node / merge_video_node）
 * 都以画布 sessionId 作 MediaGeneration.conversationId 落库，GET /conversations/:id/media 按它 + 当前用户列出。
 */
export function listCanvasMedia(page: Page, id: string): Promise<MediaGeneration[]> {
  return apiOk<MediaGeneration[]>(page, `/conversations/${id}/media`);
}

/** 轮询画布 status 直到不再是 queued / running（waiting_approval 也算停下，交给调用方处理）。 */
export async function waitCanvasSettled(
  page: Page,
  id: string,
  timeoutMs = 60_000,
): Promise<CanvasSnapshot> {
  await expect
    .poll(async () => (await getCanvas(page, id)).status, {
      timeout: timeoutMs,
      intervals: [500, 1_000, 2_000],
    })
    .not.toMatch(/^(queued|running)$/);
  return getCanvas(page, id);
}

/**
 * 清理（画布没有删除接口，见 spec 顶部说明）：停掉还在跑的、审批模式恢复 review、删光节点。
 * 画布本身留在测试账号下（账号专用，标题带 E2E 前缀）。
 */
export async function resetCanvas(page: Page, id: string): Promise<void> {
  let snap = await getCanvas(page, id);
  if (BUSY.includes(snap.status)) {
    await apiOk(page, `/canvas/${id}/stop`, { method: "POST" });
    snap = await waitCanvasSettled(page, id);
  }
  if (snap.approvalMode !== "review") {
    // 审批模式只能随消息改：发一条再立刻停掉（gate 在 worker 开跑前就拦下，agent 不会动画布）
    await apiOk(page, `/canvas/${id}/messages`, {
      method: "POST",
      body: { content: "e2e cleanup: restore review mode", approvalMode: "review" },
    });
    await apiOk(page, `/canvas/${id}/stop`, { method: "POST" });
    snap = await waitCanvasSettled(page, id);
  }
  for (const node of snap.nodes) {
    const latest = await getCanvas(page, id);
    if (!latest.nodes.some((n) => n.id === node.id)) continue;
    await api(page, `/canvas/${id}/ops`, {
      method: "POST",
      body: { baseRevision: latest.revision, op: { op: "remove_node", nodeId: node.id } },
    });
  }
}

// ---- 不产生生成任务 ----

/** 浏览器里任何「手动生成 / 拼接」请求的地址（卡片上的 Generate / Merge / Retry 背后的接口）。 */
const GENERATE_URL = /\/api-backend\/(canvas\/[^/]+\/nodes\/[^/]+\/(generate|merge)|media\/generations\/[^/]+\/regenerate)$/;

/**
 * 硬拦截：本页发出的生成 / 拼接 / 重新生成请求一律 abort（请求根本到不了后端），并记下来。
 * 返回记录数组，用例末尾断言它为空——误点了按钮也不会真的发起生成，且用例会失败。
 */
export async function blockGenerationRequests(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(GENERATE_URL, async (route) => {
    blocked.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return blocked;
}

/**
 * 断言画布没有产生任何生成任务：
 *  1. GET /conversations/:canvasId/media 为空（MediaGeneration 表里没有挂在这块画布上的记录）；
 *  2. 快照里每个节点 mediaGenerationId / mediaStatus 都为 null（没有节点被回填过生成）。
 */
export async function expectNoGeneration(page: Page, id: string): Promise<void> {
  const media = await listCanvasMedia(page, id);
  expect(media, `canvas ${id} has media generations`).toEqual([]);
  const snap = await getCanvas(page, id);
  for (const n of snap.nodes) {
    expect(n.mediaGenerationId, `node ${n.id} mediaGenerationId`).toBeNull();
    expect(n.mediaStatus, `node ${n.id} mediaStatus`).toBeNull();
  }
}

// ---- 页面 ----

/**
 * 打开画布编辑页并等骨架屏退场。chatOpen 控制右侧对话面板（localStorage 持久化的开合态）：
 * 手动搭结构时关掉，免得面板盖住画布；跟 agent 对话时打开并钉住（点画布空白不收起）。
 */
export async function openCanvas(page: Page, id: string, chatOpen: boolean): Promise<void> {
  await page.addInitScript((open) => {
    localStorage.setItem("canvas.panel.chat.open", JSON.stringify(open));
    localStorage.setItem("canvas.panel.chat.pinned", JSON.stringify(open));
    localStorage.setItem("canvas.panel.list.open", "false");
  }, chatOpen);
  await page.goto(`/canvas/${id}`);
  await waitCanvasReady(page);
}

/** 骨架屏（.canvas-boot）卸载 = 快照与历史都已落地。 */
export async function waitCanvasReady(page: Page): Promise<void> {
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.locator(".canvas-boot")).toHaveCount(0);
}

/** 画布上的节点卡片（react-flow 给每个节点挂 data-testid=rf__node-<id>）。 */
export function flowNode(page: Page, id: string): Locator {
  return page.getByTestId(`rf__node-${id}`);
}

/** 画布上的连线（data-testid=rf__edge-<id>）。 */
export function flowEdge(page: Page, id: string): Locator {
  return page.getByTestId(`rf__edge-${id}`);
}

/** 选中节点时浮出的提示词面板（react-flow NodeToolbar，渲染在节点外的 portal 里）。 */
export function composer(page: Page): Locator {
  return page.locator(".react-flow__node-toolbar");
}

/** 对话面板（右侧悬浮面板，role=complementary，名为 Canvas Agent）。 */
export function chatPanel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Canvas Agent" });
}
