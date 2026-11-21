/**
 * 窗口全屏状态 → <html data-fullscreen>：macOS 全屏时没有红绿灯，左上角为它们预留的位置（收起侧栏后的开关、
 * 各顶栏左侧的让位）改用 `fullscreen:` 变体收回（变体定义在 globals.css）。
 */
export function syncFullScreenAttribute(): void {
  const apply = (fullscreen: boolean) => {
    if (fullscreen) document.documentElement.dataset.fullscreen = '';
    else delete document.documentElement.dataset.fullscreen;
  };
  void window.desktop.isFullScreen().then(apply);
  window.desktop.onFullScreenChange(apply);
}
