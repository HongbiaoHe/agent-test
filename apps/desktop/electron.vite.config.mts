import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// main 构建两个入口：main 进程本体 + agent-host（Electron utilityProcess，跑 agent 与 SQLite）。
// dependencies 里的包（含 workspace 的 @agent-test/agent-core）按 electron-vite 默认外置，运行时从 node_modules 加载。
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'agent-host': resolve(import.meta.dirname, 'src/agent-host/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
        // video-schema 的 dist 是 CommonJS，renderer 里 import 值（layoutVideoTrack 等）会出问题：直接让 Vite 编译源码
        '@agent-test/video-schema': resolve(import.meta.dirname, '../../packages/video-schema/src/index.ts'),
        // agent-core 的 dist 同样是 CommonJS：dev 模式下 Vite 原样把它发给 renderer，具名导入（PROVIDER_PRESETS 等）
        // 直接 SyntaxError、整个界面白屏（生产构建会转换 CJS，所以只在 dev 出现）。renderer 只引它的纯函数文件
        // （providers/presets、types、model-ref、capabilities，modes 的 schema / 片段），让 Vite 编译源码
        '@agent-test/agent-core': resolve(import.meta.dirname, '../../packages/agent-core/src'),
        // canvas-schema 的 dist 同样是 CommonJS（画布视图与共享的 canvas-ui 都引它的值，如 applyPatch）
        '@agent-test/canvas-schema': resolve(import.meta.dirname, '../../packages/canvas-schema/src/index.ts'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
