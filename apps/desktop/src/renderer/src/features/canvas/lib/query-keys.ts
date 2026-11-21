/** 画布的 react-query 键 */
export const CANVAS_LIST_KEY = ['canvas-list'] as const;
export const canvasSnapshotKey = (id: string) => ['canvas', id] as const;
