# @agent-test/canvas-ui

画布编辑区（react-flow 节点编辑器）的共享 UI，web（apps/frontend）与 desktop 共用。
直接发 TS 源码（`exports` 指向 `src/`），由宿主的打包器编译：Next 需把它和 `@agent-test/ui`
加进 `transpilePackages`，Vite 无需配置。

## 宿主要提供什么

1. **`CanvasPlatformProvider`**：包内唯一的外部依赖入口（包里不 import 任何应用代码）。

   ```ts
   interface CanvasPlatform {
     locale: "en" | "zh-CN" | "zh-Hant";
     fetchMediaAssetBlob(versionId: string): Promise<Blob>;
     listAigcModels(type: "image" | "video"): Promise<AigcCatalog>;
   }
   ```

   - `locale`：包内字典（`src/i18n/messages.ts`）用哪一份；按钮、提示、aria-label、toast 全部走它。
   - `fetchMediaAssetBlob`：取媒体版本（MediaVersion.id）的二进制，卡片据此生成 blob URL；失败请 reject。
   - `listAigcModels`：生成节点的模型目录（`GET /aigc/models?type=` 的形状）。包内用 react-query
     缓存（key `["aigc-models", type]`），所以外层必须有 `QueryClientProvider`。
   - value 请保持引用稳定（模块常量或 `useMemo`）。

2. **`FlowCanvas` 的 props**（结构读写全走回调，见 `src/components/flow-canvas.tsx` 的 `FlowCanvasProps`）：
   画布投影 `CanvasState`、`readOnly`、各种 op / 生成 / 上传回调、保存状态 `saveStates`。
   上传回调的 `opts` 是 `CanvasUploadOptions`（`onProgress(0..1)` + `signal`）。

3. **全局环境**
   - 设计系统的语义 token（`--background` `--foreground` `--card` `--border` `--ring` `--primary`
     `--muted(-foreground)` `--warning` `--radius` `--font-mono` …）与 `.dark` 暗色类——web 的
     `globals.css` / desktop 的 renderer `globals.css` 都已具备。
   - Tailwind v4 要扫到包源码：在宿主的全局 CSS 里加
     ```css
     @source "<相对路径>/packages/ui/src";
     @source "<相对路径>/packages/canvas-ui/src";
     ```
   - `sonner` 的 `<Toaster />`（上传校验失败等 toast 走 sonner）。

## 样式

`src/canvas.css`（节点卡片 / 端口 / 连线强调 / agent 工作光晕 / 节点身份色 token `--node-*`、`--edge-selected`）
由 `FlowCanvas` 模块自己 import（排在 `@xyflow/react/dist/style.css` 之前），宿主不用再引。
也以 `@agent-test/canvas-ui/canvas.css` 导出，供只用零件不用 `FlowCanvas` 的场景。

## 公开面（`src/index.ts`）

- `CanvasPlatformProvider` / `useCanvasPlatform` / `CanvasPlatform` / `CanvasLocale` / `CanvasUploadOptions`
- `FlowCanvas` / `FlowCanvasProps` / `CanvasEditorContext` / `NodeContentPatch` / `ConnectMenuRequest` / `SaveState`
- 外壳也会用到的板上件：`CanvasSaveStatus`、`CanvasIsland*`、`CanvasToolbar*`、`NODE_META` / `NodeTypeIcon`
- hooks：`useIsMobile`、`useMediaAsset`、`useAigcModels` / `findAigcModel`、`resolveNodeInputs`
- i18n：`useCanvasT`、`CANVAS_MESSAGES`、`CanvasMessages`；服务端组件可走无副作用的子路径
  `@agent-test/canvas-ui/messages`

## 约定

- 文案只写在 `src/i18n/messages.ts`，en 为基准（与 web 原文逐字一致），zh-CN / zh-Hant 同结构；
  组件里写中文字面量会被 lint 拦下。参考素材的叫法 `Image 1` / `Video 1` 是提示词约定，任何语言都保持英文。
- 画布类型与规则一律来自 `@agent-test/canvas-schema`。
- `pnpm --filter @agent-test/canvas-ui typecheck` / `lint`。
