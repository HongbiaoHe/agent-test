import { STORE } from "../core/scene-config";

/**
 * 便利店建筑模块的内部尺寸表。
 * 所有数值都由 core/scene-config.ts 的 STORE 推导，模块内不再另造一套坐标。
 *
 * 竖向分层（y）：
 *   0.18 地面 / 踢脚底  0.53 踢脚顶（玻璃下沿）  2.48 玻璃顶
 *   2.48~3.23 招牌背墙  2.55~3.15 招牌带  3.23 墙顶  3.29 屋面板顶  3.35 女儿墙顶
 */
const wallT = 0.16;

export const D = {
  ...STORE,
  w: STORE.x1 - STORE.x0,
  d: STORE.z1 - STORE.z0,
  cx: (STORE.x0 + STORE.x1) / 2,
  cz: (STORE.z0 + STORE.z1) / 2,
  wallT,
  kickTopY: 0.53,
  wallTopY: 3.23,
  roofTopY: 3.29,
  interiorFloorY: STORE.floorY + 0.04,
  ceilingY: 2.44,
  /** 门洞内沿（玻璃门扇范围） x 0.15~1.75 */
  doorX0: 0.15,
  doorX1: 1.75,
  /** 门扇玻璃平面 */
  doorZ: -0.66,
  /** 橱窗玻璃平面 */
  glassZ: -0.685,
  /** 南墙中心、西墙中心（墙厚 0.16） */
  southCZ: STORE.z1 - wallT / 2,
  westCX: STORE.x0 + wallT / 2,
} as const;

/** 墙高 / 墙中心高 */
export const WALL_H = D.wallTopY - D.floorY;
export const WALL_CY = (D.floorY + D.wallTopY) / 2;
/** 橱窗玻璃高度 / 中心高 */
export const GLASS_H = D.glassTopY - D.kickTopY;
export const GLASS_CY = (D.glassTopY + D.kickTopY) / 2;
