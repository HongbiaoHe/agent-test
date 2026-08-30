"use client";

import { useCallback } from "react";

import { CANVAS_HEADER_INSET } from "../_components/canvas-header";
import {
  PANEL_INSET,
  useFloatingPanel,
  useStoredFlag,
  type DockSide,
  type FloatingPanelApi,
  type Placement,
} from "@/components/ui/floating-panel";

const STORAGE = {
  listOpen: "canvas.panel.list.open",
  listPinned: "canvas.panel.list.pinned",
  listPlacement: "canvas.panel.list.placement",
  chatOpen: "canvas.panel.chat.open",
  chatPinned: "canvas.panel.chat.pinned",
  chatPlacement: "canvas.panel.chat.placement",
} as const;

// 模块常量：useStoredState / useFloatingPanel 拿它做 useMemo 依赖，必须是稳定引用
const LIST_DEFAULT: Placement = { mode: "dock", side: "left", width: 256 };
const CHAT_DEFAULT: Placement = { mode: "dock", side: "right", width: 384 };

export interface CanvasPanels {
  list: FloatingPanelApi;
  chat: FloatingPanelApi;
  listOpen: boolean;
  chatOpen: boolean;
  listPinned: boolean;
  chatPinned: boolean;
  setListOpen: (next: boolean) => void;
  setChatOpen: (next: boolean) => void;
  setListPinned: (next: boolean) => void;
  setChatPinned: (next: boolean) => void;
  /** 触发按钮竖轨离右边缘的距离（px）：右侧被停靠面板占掉多少就往里躲多少，否则点不到 */
  triggerRailInset: number;
  /** 点画布空白处：收起没钉住的面板 */
  dismissUnpinned: () => void;
}

/**
 * 画布两块悬浮面板的开合、钉住与摆放。
 *
 * - 列表：只能贴边停靠，宽度可调，不可拖走（导航列表拖来拖去没价值）。
 * - 对话：默认停靠右侧，可拖成自由浮动，拖到画布左右边缘会吸附回停靠态。
 * - **同侧共存**：对话被吸附到列表那一侧时两块都留着，贴边位归对话（它是被拖过去
 *   主动吸附的那块），列表整体往里让出对话的宽度，并排排开。
 * - 两个入口合成右侧一条竖轨，按右侧已被占用的总宽度往里躲，不会被压在面板底下。
 * - 两块面板的顶部都让开 CANVAS_HEADER_INSET，拖动与向上缩放都进不到 header 底下。
 *
 * 开合与钉住都持久化：SSR 首帧一律用默认值（列表收、对话开），水合后读回本地缓存。
 * 面板是悬浮层不参与布局，所以这一帧差异不会造成画布跳动。
 */
export function useCanvasPanels(bounds: HTMLElement | null): CanvasPanels {
  const [listOpen, setListOpen] = useStoredFlag(STORAGE.listOpen, false);
  const [chatOpen, setChatOpen] = useStoredFlag(STORAGE.chatOpen, true);
  const [listPinned, setListPinned] = useStoredFlag(STORAGE.listPinned, false);
  const [chatPinned, setChatPinned] = useStoredFlag(STORAGE.chatPinned, false);

  // 对话先建：它的停靠侧与宽度决定列表要不要让位
  const chat = useFloatingPanel({
    storageKey: STORAGE.chatPlacement,
    defaultPlacement: CHAT_DEFAULT,
    allowFloat: true,
    minWidth: 320,
    maxWidth: 720,
    // 440 不是随手取的：面板内层是 overflow-hidden（要圆角裁切 + 兜住滚动区），
    // 而输入区的模型/思考档位切换器是向上弹的 max-h-72(288px) 浮层。
    // 标题栏 40 + 输入区 ~96 + 浮层 288 + 间距 ≈ 440，再矮浮层顶部会被裁掉。
    minHeight: 440,
    // 顶部让开悬浮 header
    topInset: CANVAS_HEADER_INSET,
    bounds,
  });

  const chatDock: DockSide | null =
    chat.placement.mode === "dock" ? chat.placement.side : null;
  const chatDockedWidth = chatOpen && chatDock ? chat.placement.width : 0;

  const list = useFloatingPanel({
    storageKey: STORAGE.listPlacement,
    defaultPlacement: LIST_DEFAULT,
    allowFloat: false,
    minWidth: 208,
    maxWidth: 420,
    minHeight: 240,
    // 对话停在列表这一侧时往里让出它的宽度；对话浮动或在另一侧则贴边
    dockOffset:
      chatDock === "left" && chatOpen ? chatDockedWidth + PANEL_INSET : 0,
    topInset: CANVAS_HEADER_INSET,
    bounds,
  });

  const listDock: DockSide | null =
    list.placement.mode === "dock" ? list.placement.side : null;

  /** 某一侧被「展开着的停靠面板」占掉的总宽度，触发按钮据此往里躲 */
  const occupiedOn = (side: DockSide) => {
    let used = 0;
    if (listOpen && listDock === side) used += list.placement.width + PANEL_INSET;
    if (chatOpen && chatDock === side) used += chat.placement.width + PANEL_INSET;
    return PANEL_INSET + used;
  };

  const dismissUnpinned = useCallback(() => {
    if (!listPinned) setListOpen(false);
    if (!chatPinned) setChatOpen(false);
  }, [listPinned, chatPinned, setListOpen, setChatOpen]);

  return {
    list,
    chat,
    listOpen,
    chatOpen,
    listPinned,
    chatPinned,
    setListOpen,
    setChatOpen,
    setListPinned,
    setChatPinned,
    // 两个入口都在右侧竖轨上，只需看右侧被占了多少
    triggerRailInset: occupiedOn("right"),
    dismissUnpinned,
  };
}
