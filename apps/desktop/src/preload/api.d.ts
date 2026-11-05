import type { DesktopApi } from '../shared/desktop';

declare global {
  interface Window {
    desktop: DesktopApi;
    desktopAgent: { requestPort(): void };
  }
}

export {};
