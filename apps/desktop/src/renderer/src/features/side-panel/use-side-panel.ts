/**
 * 侧栏状态：打开的标签、当前标签、是否显示 / 展开全部（见 side-panel-tabs.ts）、宽度（拖动调整，记在本机；不可用时用默认值）。
 */
import { useMemo, useState } from 'react';
import type { PreviewSpec } from '../viewer/preview-target';
import {
  activateTab,
  closeTab,
  EMPTY_SIDE_PANEL,
  hidePanel,
  openItem,
  openNewTab,
  type SidePanelTabs,
  togglePanel,
} from './side-panel-tabs';

const WIDTH_KEY = 'spark.sidePanel.width';
export const SIDE_PANEL_DEFAULT_WIDTH = 640;
export const SIDE_PANEL_MIN_WIDTH = 360;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= SIDE_PANEL_MIN_WIDTH ? v : SIDE_PANEL_DEFAULT_WIDTH;
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

export function useSidePanel() {
  const [state, setState] = useState<SidePanelTabs>(EMPTY_SIDE_PANEL);
  const [width, setWidth] = useState(readWidth);

  // 操作函数引用稳定（只用 setState）：放进订阅 effect 的依赖、传给 FileViewerProvider 都不会每次渲染重建
  const actions = useMemo(
    () => ({
      // 打开内容：各占一个标签，已经开着就切过去（网页会重新加载）
      openSite: (spec: PreviewSpec) => setState((s) => openItem(s, { kind: 'site', spec, openCount: 0 })),
      openVideo: (path: string) => setState((s) => openItem(s, { kind: 'video', path })),
      openCanvas: (canvasId: string) => setState((s) => openItem(s, { kind: 'canvas', canvasId })),
      /** 加号 / 「会话详情」里的「产出物」：打开（或切到）新建标签页 */
      newTab: () => setState(openNewTab),
      activate: (id: string) => setState((s) => activateTab(s, id)),
      closeTab: (id: string) => setState((s) => closeTab(s, id)),
      /** 顶栏最右的侧栏开关：开着就收起，收起着就打开（没有标签时给一个新建标签页） */
      toggle: () => setState(togglePanel),
      /** 收起侧栏：所有标签一起收起，都留着 */
      hide: () => setState(hidePanel),
      toggleExpanded: () => setState((s) => ({ ...s, expanded: !s.expanded })),
      /** 收回停靠（如 agent 发来审批：展开时会盖住对话里的审批面板） */
      collapse: () => setState((s) => (s.expanded ? { ...s, expanded: false } : s)),
      /** 拖动松手后的宽度（拖动途中由侧栏直接改 DOM，不经这里，免得整个对话视图每帧重渲染） */
      resize: (w: number) => setWidth(Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(w))),
      commitWidth: (w: number) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(w))));
        } catch {
          // 存不了就只在本次会话里生效
        }
      },
    }),
    [],
  );

  // actions 单独给一份（引用稳定）：侧栏组件 memo 时只认 tabs / activeId / open / expanded / width / actions，
  // 对话流式输出不牵连它
  return { ...state, width, actions, ...actions };
}

export type SidePanelState = ReturnType<typeof useSidePanel>;
export type SidePanelActions = SidePanelState['actions'];
