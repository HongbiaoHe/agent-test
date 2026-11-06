import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// agent-host 的单测跑在普通 Node 22 上：数据库用内置 node:sqlite，没有原生模块，不需要 Electron 运行时。
// renderer 的纯函数单测也在这里跑：'@' 别名同 electron.vite.config，界面文案按简体中文初始化（见 vitest.setup.ts）。
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
