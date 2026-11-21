/**
 * desktop 画布视图与 agent-host 之间的共享类型（画布本身的类型在 @agent-test/canvas-schema）。
 */

/**
 * agent-host 转发给画布视图的实时事件（来自 Web 后端的画布事件流，见 agent-host/canvas/canvas-watcher.ts）：
 *  - canvas_patch：结构增量（payload 是 CanvasPatch），直接应用；
 *  - canvas_lock / media_update / result / error：重拉快照（运行锁、生成状态、Web 画布 agent 跑完）；
 *  - resync：实时连接断线重连，断线期间的增量没收到，重拉快照。
 */
export interface CanvasStreamEvent {
  type: string;
  payload?: unknown;
}

/** 上传节点拿不到本机路径、只能传字节时的上限（字节要经 MessagePort 搬一份，太大会撑爆内存） */
export const CANVAS_INLINE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** 绑定画布的 agent 工具名（agent-host 注册、renderer 据此在对话里出画布卡片，两边共用这一份） */
export const LIST_CANVASES_TOOL = 'list_canvases';
export const CREATE_CANVAS_TOOL = 'create_canvas';
export const OPEN_CANVAS_TOOL = 'open_canvas';
/** 对话里出画布卡片的工具 */
export const CANVAS_CARD_TOOLS: readonly string[] = [CREATE_CANVAS_TOOL, OPEN_CANVAS_TOOL];
