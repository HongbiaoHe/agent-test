import { defineConfig } from 'vitest/config';

// agent-host 的单测跑在普通 Node 22 上：数据库用内置 node:sqlite，没有原生模块，不需要 Electron 运行时。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
