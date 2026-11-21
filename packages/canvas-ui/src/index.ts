/**
 * @agent-test/canvas-ui 的公开面：画布编辑区（react-flow 节点编辑器）与它的平台适配层。
 * 宿主（web / desktop）只从这里取；包内其余文件是内部实现。契约说明见 README.md。
 */

// —— 平台适配（宿主实现）——
export {
  CanvasPlatformProvider,
  useCanvasPlatform,
  type CanvasLocale,
  type CanvasPlatform,
  type CanvasUploadOptions,
} from "./platform";

// —— 画布本体 ——
export {
  CanvasEditorContext,
  FlowCanvas,
  type ConnectMenuRequest,
  type FlowCanvasProps,
  type NodeContentPatch,
} from "./components/flow-canvas";
export type { SaveState } from "./lib/save-state";

// —— 画布外壳也会用到的板上 UI（保存状态、浮岛、工具条、节点类型图标）——
export { CanvasSaveStatus } from "./components/canvas-save-status";
export {
  CANVAS_ISLAND_CLASS,
  CanvasIsland,
  CanvasIslandButton,
  CanvasIslandDivider,
} from "./components/canvas-island";
export {
  CanvasToolbar,
  CanvasToolbarAction,
  CanvasToolbarButton,
  CanvasToolbarCount,
  CanvasToolbarSeparator,
} from "./components/canvas-toolbar";
export { NODE_META, NodeTypeIcon } from "./components/node-meta";

// —— hooks / 纯逻辑 ——
export {
  useCanvasBoard,
  type CanvasBoard,
  type CanvasBoardSource,
  type UseCanvasBoardOptions,
} from "./hooks/use-canvas-board";
export { useIsMobile } from "./hooks/use-is-mobile";
export { useMediaAsset, type MediaAsset } from "./hooks/use-media-asset";
export { findAigcModel, useAigcModels } from "./hooks/use-aigc-models";
export { resolveNodeInputs, type NodeInputSource } from "./lib/node-io";

// —— i18n ——
export { useCanvasT } from "./i18n/use-canvas-t";
export { CANVAS_MESSAGES, type CanvasMessages } from "./i18n/messages";
