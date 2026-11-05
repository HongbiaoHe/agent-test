import { useEffect, useSyncExternalStore } from 'react';

/**
 * 跟随系统亮 / 暗：在 <html> 上挂 / 摘 `.dark`（与 Web 端同一套 .dark 机制，见 DESIGN.md §7）。
 * 用 useSyncExternalStore 订阅 matchMedia，避免在 effect 里同步 setState。
 */
const query = '(prefers-color-scheme: dark)';

function subscribe(cb: () => void): () => void {
  const mql = window.matchMedia(query);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

export function useSystemTheme(): 'light' | 'dark' {
  const dark = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
  const theme = dark ? 'dark' : 'light';
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return theme;
}
