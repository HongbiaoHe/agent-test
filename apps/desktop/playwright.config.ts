import { defineConfig } from '@playwright/test';

// Electron 端到端：直接拉起 out/ 下的构建产物（先 electron-vite build），不需要浏览器下载
export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
