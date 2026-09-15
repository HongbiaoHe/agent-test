/** 面板停靠的画布侧边。 */
export type DockSide = "left" | "right";

/**
 * 贴边停靠：左右贴边，宽度可调；上下两条边也都能拖。
 * - `y` 缺省 = 顶到画布 header 底边（topInset）；从顶边拖下来才记具体值。
 * - `height` 缺省 = 从 y 一直延伸到画布底部；从底边拖上来才记具体值。
 * 两者都缺省就是升级前的"占满该侧全高"，旧的持久化数据因此无需迁移；
 * 缺省值跟随窗口尺寸变化，记成像素就钉死了。
 */
export interface DockPlacement {
  mode: "dock";
  side: DockSide;
  width: number;
  y?: number;
  height?: number;
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
