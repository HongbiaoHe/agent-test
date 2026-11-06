/**
 * 侧栏收起 / 临时弹出 / 宽度的状态：
 * - collapsed：用户点开关收起，记在 localStorage（本机偏好，读写失败就按展开处理）；
 * - width：拖侧栏右缘调整，限在 [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]，松手后记进 localStorage；浮层沿用同一宽度；
 * - peek：收起时鼠标悬停开关 → 侧栏以浮层临时弹出。浮层打开期间监听 document 的 pointermove：
 *   指针离开「浮层区」（开关与浮层，标了 data-peek-zone）稍等片刻才收回，回到浮层区就取消；
 *   浮层里的菜单 / 弹窗开着时不收（它们渲染在浮层之外，收了会连同菜单一起卸载）。
 *   不用主区的 mouseenter：实测指针从开关直接移进主区时偶发不触发，浮层收不回去。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'spark.sidebarCollapsed';
const WIDTH_STORAGE_KEY = 'spark.sidebarWidth';
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
const PEEK_CLOSE_DELAY_MS = 250;
/** 标在开关与浮层容器上的属性（JSX 里直接写 data-peek-zone） */
const PEEK_ZONE_ATTR = 'data-peek-zone';
const OPEN_POPUP_SELECTOR =
  '[data-slot="dropdown-menu-content"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w)));

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return saved ? clampWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function useSidebarLayout() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const [peek, setPeek] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  useEffect(() => cancelClose, []);

  const toggle = useCallback(() => {
    cancelClose();
    setPeek(false);
    setCollapsed((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // 存不了就只在本次生效
      }
      return next;
    });
  }, []);

  /** 悬停开关或浮层：打开（或保持）浮层 */
  const openPeek = useCallback(() => {
    cancelClose();
    if (collapsed) setPeek(true);
  }, [collapsed]);

  const open = collapsed && peek;
  useEffect(() => {
    if (!open) return;
    const onMove = (e: PointerEvent) => {
      const inZone = e.target instanceof Element && e.target.closest(`[${PEEK_ZONE_ATTR}]`) !== null;
      if (inZone || document.querySelector(OPEN_POPUP_SELECTOR)) {
        cancelClose();
      } else if (closeTimer.current === undefined) {
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = undefined;
          setPeek(false);
        }, PEEK_CLOSE_DELAY_MS);
      }
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [open]);

  const closePeek = useCallback(() => {
    cancelClose();
    setPeek(false);
  }, []);

  /** 拖动中：按指针位置设宽度（侧栏贴窗口左缘，宽度即指针 x） */
  const resize = useCallback((w: number) => {
    setResizing(true);
    setWidth(clampWidth(w));
  }, []);
  const endResize = useCallback(() => setResizing(false), []);
  // 拖动中不写盘，松手再记
  useEffect(() => {
    if (resizing) return;
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // 存不了就只在本次生效
    }
  }, [width, resizing]);

  return { collapsed, peek: open, toggle, openPeek, closePeek, width, resizing, resize, endResize };
}
