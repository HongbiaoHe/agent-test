/**
 * 雨夜便利店街角 —— 场景整体规格（尺寸 / 配色 / 时间轴）。
 *
 * 这是整个微缩场景的「唯一坐标与颜色来源」：底座 12×12、y=0 为台面，
 * 南侧（+z）与西侧（−x）是两条马路，便利店位于交角内侧。所有组件都从这里
 * 取色取坐标，禁止在组件里另造一套色板，否则 3D 场景会花。
 *
 * 坐标约定（右手系，+y 向上）：
 *   +x 向东 / −x 向西（西侧马路）
 *   +z 向南 / −z 向北（南侧马路，店门朝向）
 */

export type Vec3 = [number, number, number];

/** 底座 */
export const BASE = {
  size: 12,
  thickness: 0.6,
  cornerRadius: 0.12,
  topY: 0,
} as const;

/** 人行道（整块 L 形高台，顶面 y=0.18） */
export const SIDEWALK = {
  topY: 0.18,
  x0: -3.6,
  x1: 6,
  z0: -6,
  z1: 2.8,
} as const;

/** 马路（顶面 y=0.02，略低于底座顶面，形成路缘高差） */
export const ROAD = {
  topY: 0.02,
  south: { x0: -6, x1: 6, z0: 2.8, z1: 6 },
  west: { x0: -6, x1: -3.6, z0: -6, z1: 2.8 },
  curbWidth: 0.24,
} as const;

/** 便利店主体尺寸（坐落在人行道 y=0.18 上） */
export const STORE = {
  x0: -1.8,
  x1: 4.2,
  z0: -4.9,
  z1: -0.6,
  floorY: 0.18,
  glassTopY: 2.48,
  signBottomY: 2.55,
  signTopY: 3.15,
  parapetTopY: 3.35,
} as const;

/** 关键点位（组件摆放的锚点，统一放这里避免互相穿模） */
export const ANCHOR = {
  doorCenterX: 0.95,
  doorWidth: 1.6,
  entranceZ: -0.58,
  mat: [0.95, SIDEWALK.topY + 0.005, 0.18] as Vec3,
  awning: { x0: -0.7, x1: 2.55, y: 2.32, z0: -0.6, z1: 0.52 },
  vending: [
    { x: -2.24, z: -1.55, ry: -Math.PI / 2 },
    { x: -2.24, z: -2.72, ry: -Math.PI / 2 },
  ] as const,
  pylon: { x: -2.72, z: 1.32, ry: Math.PI / 4 },
  bike: { x: 3.02, z: 0.9, ry: -0.62 },
  bins: { x: 3.62, z: -0.16 },
  umbrella: { x: 2.18, z: -0.2 },
  aBoard: { x: 2.5, z: 0.62, ry: -0.3 },
  cat: { x: -2.85, z: -0.98 },
  parking: { x0: 4.4, x1: 5.96, z0: 0.3, z1: 2.55 },
  lamp: { x: 3.35, z: 2.28 },
  pole: { x: -3.16, z: -0.86 },
  corner: { x: -3.6, z: 2.8 },
  mirror: { x: -3.22, z: 2.5 },
  alley: { x0: 4.2, x1: 6, z0: -4.9, z1: 0.65 },
  noticeBoard: { x: 4.19, y: 1.55, z: -2.0 },
} as const;

/** 积水位置（街道放水洼、雨滴涟漪共用，避免两个模块各放一套对不上） */
export const PUDDLES = [
  { x: -1.9, z: 4.9, rx: 0.95, rz: 0.5, y: ROAD.topY + 0.016 },
  { x: 2.3, z: 3.5, rx: 0.72, rz: 0.4, y: ROAD.topY + 0.016 },
  { x: -4.7, z: 1.1, rx: 0.78, rz: 0.46, y: ROAD.topY + 0.016 },
  { x: -5.1, z: 4.6, rx: 0.6, rz: 0.34, y: ROAD.topY + 0.016 },
  { x: 1.5, z: 1.7, rx: 0.62, rz: 0.32, y: SIDEWALK.topY + 0.014 },
  { x: 4.86, z: -1.45, rx: 0.5, rz: 0.36, y: SIDEWALK.topY + 0.014 },
] as const;

/** 默认机位（围绕 target 的球坐标方向由这里反推，适配横竖屏） */
export const CAMERA = {
  fov: 36,
  target: [0.15, 1.35, -0.9] as Vec3,
  /** 相机相对 target 的方向（从西南方、略带俯视看整个街角） */
  direction: [-0.53, 0.255, 0.809] as Vec3,
  fitRadius: 8.05,
  fitFactor: 0.86,
  minDistance: 7,
  maxDistance: 42,
  introDuration: 2.4,
} as const;

/** 入场组装时间轴（单位秒，从场景挂载开始） */
export const TIMING = {
  /** 相机推近 */
  camera: 0,
  /** 底座从地面升起（必须先落位，后面的散件才有"从地里长出来"的遮挡关系） */
  base: 0.05,
  /** 地面 / 马路 / 斑马线等铺装 */
  ground: 0.75,
  /** 便利店建筑主体 */
  store: 1.25,
  /** 室内货架 / 冷柜 / 收银台 */
  interior: 2.05,
  /** 招牌 / 雨棚 / 门头 */
  signage: 2.25,
  /** 门口小品（贩卖机 / 自行车 / 垃圾桶…） */
  props: 2.6,
  /** 街道设施（路灯 / 电线杆 / 护栏 / 路牌…） */
  fixtures: 2.9,
  /** 通电：灯一盏盏亮起来 */
  power: 3.9,
  /** 雨落下 */
  rain: 4.45,
  /** 组装结束（此后只有循环动画） */
  end: 6.3,
} as const;

/**
 * 夜间三渲二配色。
 * 冷色打底（蓝紫夜色），暖色全部来自霓虹 / 便利店灯光，形成对比。
 */
export const PALETTE = {
  // 夜色
  background: "#070a15",
  fog: "#0a1020",
  outline: "#080a12",
  moon: "#a9c2ff",
  ambient: "#7d8ec8",

  // 底座
  base: "#10141f",
  baseRim: "#232b3d",
  baseGlow: "#33456e",

  // 路 / 人行道
  asphalt: "#151b2b",
  asphaltDark: "#101524",
  sidewalk: "#2b3242",
  sidewalkJoint: "#202634",
  curb: "#4b5368",
  gutter: "#0c101a",
  concrete: "#6c7388",
  metal: "#3b4457",
  darkMetal: "#1c2230",

  // 建筑
  storeWall: "#ded7c7",
  storeWallShade: "#c4bda9",
  storeTrim: "#f1ebdd",
  glass: "#9ec9dd",
  glassDark: "#2a3e52",
  roof: "#343b4c",
  interior: "#ffdcae",
  interiorBright: "#fff3d8",
  shelf: "#c9c2b2",

  // 品牌（虚构「ひかりマート / HIKARI MART」）
  brand: "#2fc8a5",
  brandAlt: "#ff9a3d",
  brandDeep: "#123a3a",
  brandInk: "#1b2b2c",

  // 街具 / 自然
  white: "#dfe6f2",
  cream: "#efe6d2",
  wood: "#6b4a35",
  woodLight: "#8d6a4c",
  leaf: "#2e5a4c",
  leafDark: "#1c3a33",
  leafLight: "#4c7d67",
  water: "#0a1020",

  // 灯光 / 霓虹
  lampWarm: "#ffbf75",
  warmLight: "#ffb877",
  neonPink: "#ff5f9e",
  neonCyan: "#5fe6ff",
  neonViolet: "#9a7bff",
  neonGreen: "#5cffb1",
  rain: "#a8c2ff",
} as const;
