/**
 * 悬浮岛的配色方案。
 *
 * 这些色值是「被验收的 3D 产物」自身的颜色数据（与 Blender 渲染管线一一对应），
 * 不是页面 UI 色板 —— 页面 UI 一律走设计系统语义 token。
 */
export type PaletteId = "A" | "B" | "C" | "D";

export type Vec3 = [number, number, number];

export type Palette = {
  id: PaletteId;
  name: string;
  /** 天空渐变，从地平线（索引 0）到天顶（索引 4） */
  sky: [string, string, string, string, string];
  /** glTF 材质名 → base color */
  materials: Record<string, string>;
  key: { color: string; intensity: number; position: Vec3 };
  fill: { color: string; intensity: number; position: Vec3 };
  hemi: { sky: string; ground: string; intensity: number };
};

const COMMON_FILL: Vec3 = [-9, 4.5, -7];

export const PALETTES: Record<PaletteId, Palette> = {
  A: {
    id: "A",
    name: "日落暖调",
    sky: ["#6d4a3a", "#e9a671", "#f7e6cc", "#93b9e2", "#2c4a8a"],
    materials: {
      Grass: "#66a83f",
      Leaf_A: "#2f7a45",
      Leaf_B: "#48995a",
      Rock: "#9a8f80",
      Trunk: "#6b4a33",
      Bird: "#4a4038",
      Beak: "#d89a4a",
      Goat: "#e8e0d0",
      GoatDark: "#4a4038",
      Cow: "#f2ece2",
      CowDark: "#3a3532",
    },
    key: { color: "#ffe0b8", intensity: 3.1, position: [6, 11, 7] },
    fill: { color: "#a8c8ff", intensity: 0.85, position: COMMON_FILL },
    hemi: { sky: "#e8f1ff", ground: "#c08a60", intensity: 1.05 },
  },
  B: {
    id: "B",
    name: "清晨薄荷",
    sky: ["#9fc4b8", "#cfe8d8", "#eef8f0", "#9ed7ea", "#2f7fb8"],
    materials: {
      Grass: "#63a84f",
      Leaf_A: "#2f7050",
      Leaf_B: "#4b8f66",
      Rock: "#a8b3b0",
      Trunk: "#6f5138",
      Bird: "#4f4a3c",
      Beak: "#d8a45a",
      Goat: "#eef2ea",
      GoatDark: "#4f4a3c",
      Cow: "#f4f7f2",
      CowDark: "#43403c",
    },
    key: { color: "#fff2d8", intensity: 3.3, position: [5, 12, 6] },
    fill: { color: "#bfe0ff", intensity: 0.9, position: COMMON_FILL },
    hemi: { sky: "#ffffff", ground: "#c8d8cf", intensity: 1.2 },
  },
  C: {
    id: "C",
    name: "午夜蓝紫",
    sky: ["#14152b", "#262a52", "#3a3d70", "#565a9e", "#0a0b20"],
    materials: {
      Grass: "#356a5c",
      Leaf_A: "#204f46",
      Leaf_B: "#2f6f5e",
      Rock: "#565b70",
      Trunk: "#3d3348",
      Bird: "#6a7098",
      Beak: "#9aa0c8",
      Goat: "#b9bed8",
      GoatDark: "#3a3d5c",
      Cow: "#cfd4e6",
      CowDark: "#2f3247",
    },
    key: { color: "#c8d4ff", intensity: 1.8, position: [4.5, 10, 8] },
    fill: { color: "#8f9dff", intensity: 1.1, position: COMMON_FILL },
    hemi: { sky: "#7a86d8", ground: "#3a3058", intensity: 0.85 },
  },
  D: {
    id: "D",
    name: "沙漠陶土",
    sky: ["#8a5a3c", "#e0a878", "#f3dcc0", "#a8c8c0", "#4a7a9a"],
    materials: {
      Grass: "#c9a05a",
      Leaf_A: "#7a8a4a",
      Leaf_B: "#93a05a",
      Rock: "#b07a55",
      Trunk: "#6b4a33",
      Bird: "#5f4633",
      Beak: "#c8863a",
      Goat: "#e6cba6",
      GoatDark: "#5f4633",
      Cow: "#f0dfc4",
      CowDark: "#4a3a2c",
    },
    key: { color: "#ffd9a0", intensity: 3.4, position: [8, 8, 6] },
    fill: { color: "#ffe6c0", intensity: 0.7, position: COMMON_FILL },
    hemi: { sky: "#ffe8cc", ground: "#b47a4e", intensity: 1.1 },
  },
};

export const PALETTE_ORDER: PaletteId[] = ["A", "B", "C", "D"];

/** 与 Blender 里天空穹顶的 5 段色标位置一致 */
const SKY_STOPS = [0, 44, 50.5, 60, 100] as const;

export function skyGradient(sky: Palette["sky"]): string {
  const stops = sky.map((color, index) => `${color} ${SKY_STOPS[index]}%`);
  return `linear-gradient(to top, ${stops.join(", ")})`;
}
