/**
 * 侧栏状态：打开的内容、是否展开全部、宽度（拖动调整，记在本机；不可用时用默认值）。
 */
import { useMemo, useState } from 'react';
import type { PreviewSpec } from '../viewer/preview-target';
import type { SidePanelItem } from './types';

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
  const [item, setItem] = useState<SidePanelItem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(readWidth);

  // 操作函数引用稳定（只用 setState）：放进订阅 effect 的依赖、传给 FileViewerProvider 都不会每次渲染重建
  const actions = useMemo(
    () => ({
      openSite: (spec: PreviewSpec) =>
        setItem((cur) => ({ kind: 'site', spec, openCount: cur?.kind === 'site' ? cur.openCount + 1 : 0 })),
      openVideo: (path: string) => setItem({ kind: 'video', path }),
      openCanvas: (canvasId: string) => setItem({ kind: 'canvas', canvasId }),
      /** 顶栏最右的侧栏开关：开着（不管开的是什么）就关，没开就打开启动页 */
      toggleLauncher: () => {
        setItem((cur) => (cur ? null : { kind: 'launcher' }));
        setExpanded(false);
      },
      /** 打开启动页（「会话详情」里点「产出物」） */
      openLauncher: () => setItem({ kind: 'launcher' }),
      close: () => {
        setItem(null);
        setExpanded(false);
      },
      toggleExpanded: () => setExpanded((v) => !v),
      /** 收回停靠（如 agent 发来审批：展开时会盖住对话里的审批面板） */
      collapse: () => setExpanded(false),
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

  // actions 单独给一份（引用稳定）：侧栏组件 memo 时只认 item / expanded / width / actions，对话流式输出不牵连它
  return { item, expanded, width, actions, ...actions };
}

export type SidePanelState = ReturnType<typeof useSidePanel>;
export type SidePanelActions = SidePanelState['actions'];
