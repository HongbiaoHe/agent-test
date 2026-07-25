"use client";

import { useCallback, useSyncExternalStore } from "react";

/** 手机断点：与 Tailwind 的 md（768px）对齐，767.98 避开小数宽度的边界抖动。 */
const MOBILE_QUERY = "(max-width: 767.98px)";

/**
 * 是否手机尺寸。用 useSyncExternalStore 订阅 matchMedia（同 use-panel-collapsed 的范式）：
 * 不在 effect 里 setState，规避 Next16 的 react-hooks/set-state-in-effect（error 级）。
 *
 * SSR 与首个客户端渲染都返回 false（桌面），与服务端一致以避免水合不匹配；水合后立即读真值。
 * 手机上因此会有一帧桌面布局——外壳已用 CSS 兜住（见 canvas-shell 的 md: 断点类），
 * 那一帧里两侧栏本就是隐藏的，不会看到侧栏闪现。
 */
export function useIsMobile(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
