/** 面板停靠的画布侧边。 */
export type DockSide = "left" | "right";

/** 贴边停靠：占满该侧全高，只有宽度可调。 */
export interface DockPlacement {
  mode: "dock";
  side: DockSide;
  width: number;
}

/** 自由浮动：位置与尺寸都可调，坐标相对画布容器左上角。 */
export interface FloatPlacement {
  mode: "float";
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Placement = DockPlacement | FloatPlacement;

/** 缩放把手方向；两字母 = 角把手。 */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 像素矩形（相对画布容器）。拖动/缩放期间的实时值与最终落位都用它。 */
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
