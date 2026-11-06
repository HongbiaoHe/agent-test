/**
 * 侧栏收起 / 临时弹出的状态：
 * - collapsed：用户点开关收起，记在 localStorage（本机偏好，读写失败就按展开处理）；
 * - peek：收起时鼠标悬停开关 → 侧栏以浮层临时弹出。浮层打开期间监听 document 的 pointermove：
 *   指针离开「浮层区」（开关与浮层，标了 data-peek-zone）稍等片刻才收回，回到浮层区就取消；
 *   浮层里的菜单 / 弹窗开着时不收（它们渲染在浮层之外，收了会连同菜单一起卸载）。
 *   不用主区的 mouseenter：实测指针从开关直接移进主区时偶发不触发，浮层收不回去。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'spark.sidebarCollapsed';
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

export function useSidebarLayout() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
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

  return { collapsed, peek: open, toggle, openPeek, closePeek };
}
