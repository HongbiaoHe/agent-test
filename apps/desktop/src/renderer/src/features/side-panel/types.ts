/**
 * 对话右侧侧栏里能打开的东西：网页预览、剪辑器、画布，以及「新建标签页」（列出可打开的产出物）。
 * 侧栏是一个带标签的容器，这些可以同时开着（见 side-panel-tabs.ts）。
 * 侧栏默认从右侧弹开、挤压对话；「展开全部」时盖住对话区（不盖左侧会话栏），对话仍在、随时收回。
 */
import type { PreviewSpec } from '../viewer/preview-target';

export type SidePanelItem =
  /** openCount：同一个页面再次打开（agent 改完页面又调 preview_page）也要重新加载 */
  | { kind: 'site'; spec: PreviewSpec; openCount: number }
  /** 剪辑工程（会话工作区里的 videos/*.sparkvideo.json） */
  | { kind: 'video'; path: string }
  /** 画布（Web 账号下的画布 id）：对话本身就在旁边，侧栏里不再带对话栏 */
  | { kind: 'canvas'; canvasId: string }
  /** 新建标签页：本会话可预览的产出物（点了就在这个标签里打开那一项） */
  | { kind: 'launcher' };

/** 侧栏里的一个标签：内容 + 身份（同一个内容只占一个标签，见 side-panel-tabs.ts 的 tabId） */
export type SideTab = SidePanelItem & { id: string };
