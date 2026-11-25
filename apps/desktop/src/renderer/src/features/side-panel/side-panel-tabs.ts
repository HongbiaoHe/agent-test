/**
 * 侧栏里打开了哪些标签（纯函数，单测见 side-panel-tabs.test.ts）。
 *
 * 侧栏是一个容器：网页预览、剪辑器、画布可以同时开着，各占一个标签；收起侧栏是整个容器一起收起，
 * 标签都留着，再打开回到原来的样子。同一个内容只占一个标签——再次打开就是切过去
 * （网页还会重新加载：agent 改完页面又调了一次 preview_page）。
 * 加号打开「新建标签页」（列出本会话可打开的产出物）；在它上面打开内容就地换掉它，像浏览器的新标签页。
 */
import { previewLocation } from '../viewer/preview-target';
import type { SidePanelItem, SideTab } from './types';

export interface SidePanelTabs {
  tabs: SideTab[];
  /** 当前标签；一个标签都没有时为 null */
  activeId: string | null;
  /** 侧栏是否显示（收起时标签还在） */
  open: boolean;
  /** 展开全部：盖住对话区 */
  expanded: boolean;
}

export const EMPTY_SIDE_PANEL: SidePanelTabs = { tabs: [], activeId: null, open: false, expanded: false };

/** 标签的身份：同一个网页地址 / 剪辑工程 / 画布只开一个标签；新建标签页也只有一个 */
export function tabId(item: SidePanelItem): string {
  if (item.kind === 'site') return `site:${previewLocation(item.spec)}`;
  if (item.kind === 'video') return `video:${item.path}`;
  if (item.kind === 'canvas') return `canvas:${item.canvasId}`;
  return 'launcher';
}

/** 打开一个内容并切过去（侧栏收起着就重新显示） */
export function openItem(state: SidePanelTabs, item: SidePanelItem): SidePanelTabs {
  const id = tabId(item);
  const active = state.tabs.find((t) => t.id === state.activeId);
  // 是从「新建标签页」上打开的：它的位置让给打开的内容（已经开着就直接收掉它）
  const fromLauncher = active?.kind === 'launcher' && item.kind !== 'launcher';
  const existing = state.tabs.find((t) => t.id === id);
  let tabs: SideTab[];
  if (existing) {
    tabs = state.tabs
      .filter((t) => !(fromLauncher && t.id === active.id))
      .map((t) =>
        t.id !== id
          ? t
          : t.kind === 'site' && item.kind === 'site'
            ? { ...t, spec: item.spec, openCount: t.openCount + 1 }
            : t,
      );
  } else {
    const tab: SideTab = { ...item, id };
    tabs = fromLauncher ? state.tabs.map((t) => (t.id === active.id ? tab : t)) : [...state.tabs, tab];
  }
  return { ...state, tabs, activeId: id, open: true };
}

/** 加号 / 「产出物」入口：打开（或切到）新建标签页 */
export function openNewTab(state: SidePanelTabs): SidePanelTabs {
  return openItem(state, { kind: 'launcher' });
}

export function activateTab(state: SidePanelTabs, id: string): SidePanelTabs {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}

/** 关一个标签：关的是当前标签就切到它右边那个（没有就左边）；全关完侧栏收起 */
export function closeTab(state: SidePanelTabs, id: string): SidePanelTabs {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return EMPTY_SIDE_PANEL;
  const activeId = state.activeId === id ? (tabs[index] ?? tabs[index - 1]).id : state.activeId;
  return { ...state, tabs, activeId };
}

/** 收起侧栏：所有标签一起收起（都留着） */
export function hidePanel(state: SidePanelTabs): SidePanelTabs {
  return { ...state, open: false, expanded: false };
}

/** 顶栏的侧栏开关：开着就收起；收起着就打开（一个标签都没有时给一个新建标签页） */
export function togglePanel(state: SidePanelTabs): SidePanelTabs {
  if (state.open) return hidePanel(state);
  return state.tabs.length === 0 ? openNewTab(state) : { ...state, open: true };
}
