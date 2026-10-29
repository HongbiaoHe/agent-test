"use client";

import * as THREE from "three";

import { PALETTE } from "../core/scene-config";
import { canvasTexture, JP_FONT, mixHex, roundRect } from "../core/textures";

/**
 * props 模块专用的程序化贴图：
 * - 自动贩卖机正面（整面灯箱，冷饮机 / 热饮机两套）
 * - 资源回收桶标签（カン / ビン / ペット）
 *
 * 颜色全部由 PALETTE 混出，不另造高饱和色板；贩卖机的红机身是 ART-SPEC §3C
 * 明确要求的“红白机”，用低饱和砖红，夜里不会抢霓虹的饱和度。
 */

export type VendingVariant = "cool" | "warm";

export type VendingLook = {
  /** 机身主色（Toon 材质用） */
  body: string;
  /** 机身暗部 / 侧面（Toon 材质用） */
  bodyShade: string;
  /** 正面灯箱的饰条色 */
  accent: string;
  /** 灯箱亮面（光晕 sprite 用） */
  glow: string;
  /** 顶部灯箱底色 / 字色 */
  header: string;
  headerInk: string;
  /** 正面大字 */
  label: string;
  hot: boolean;
};

export const VENDING_LOOKS: Record<VendingVariant, VendingLook> = {
  cool: {
    body: PALETTE.white,
    bodyShade: mixHex(PALETTE.white, PALETTE.glassDark, 0.42),
    accent: mixHex(PALETTE.neonCyan, PALETTE.glassDark, 0.45),
    glow: PALETTE.neonCyan,
    header: mixHex(PALETTE.neonCyan, PALETTE.glassDark, 0.5),
    headerInk: "#f2fdff",
    label: "つめた〜い",
    hot: false,
  },
  warm: {
    // 低饱和砖红，介于 PALETTE.brandAlt 与 PALETTE.neonPink 之间，压暗后不刺眼
    body: "#a8473a",
    bodyShade: "#75302a",
    accent: mixHex(PALETTE.brandAlt, PALETTE.darkMetal, 0.35),
    glow: PALETTE.warmLight,
    header: mixHex(PALETTE.cream, PALETTE.brandAlt, 0.18),
    headerInk: "#8c3327",
    label: "あったか〜い",
    hot: true,
  },
};

type Drink = { color: string; text: string; price: string };

const COOL_DRINKS: Drink[][] = [
  [
    { color: "#b23b3b", text: "COLA", price: "130" },
    { color: "#4b7d4a", text: "TEA", price: "150" },
    { color: "#3f86b5", text: "WATER", price: "120" },
    { color: "#e6e2d4", text: "MILK", price: "140" },
  ],
  [
    { color: "#5078bd", text: "SPORT", price: "160" },
    { color: "#7a4f33", text: "COFFEE", price: "130" },
    { color: "#c2a03a", text: "LEMON", price: "140" },
    { color: "#43988c", text: "SODA", price: "130" },
  ],
  [
    { color: "#c26a3a", text: "ORANGE", price: "130" },
    { color: "#8e5aa0", text: "GRAPE", price: "140" },
    { color: "#a8473a", text: "TEA", price: "150" },
    { color: "#d8cfa8", text: "BARLEY", price: "130" },
  ],
];

const WARM_DRINKS: Drink[][] = [
  [
    { color: "#7a4f33", text: "COCOA", price: "150" },
    { color: "#b08a5e", text: "MILK", price: "140" },
    { color: "#a8473a", text: "TEA", price: "150" },
    { color: "#5e3c2a", text: "COFFEE", price: "130" },
  ],
  [
    { color: "#c9a63a", text: "CORN", price: "150" },
    { color: "#6a7d4a", text: "GREEN", price: "140" },
    { color: "#8c5a36", text: "COFFEE", price: "130" },
    { color: "#d8cfa8", text: "SOY", price: "140" },
  ],
  [
    { color: "#b23b3b", text: "RED", price: "130" },
    { color: "#e6e2d4", text: "MILK", price: "140" },
    { color: "#7a4f33", text: "COCOA", price: "150" },
    { color: "#a8473a", text: "TEA", price: "150" },
  ],
];

/** 画一罐饮料（含银色罐盖、标签带、竖高光） */
function drawCan(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  drink: Drink,
  hot: boolean,
): void {
  const width = 46;
  const height = 106;
  const bodyTop = top + height * 0.16;
  const bodyHeight = height * 0.84;

  ctx.fillStyle = drink.color;
  roundRect(ctx, cx - width / 2, bodyTop, width, bodyHeight, 6);
  ctx.fill();

  // 罐盖（银色）
  ctx.fillStyle = "#c9d3df";
  roundRect(ctx, cx - width / 2, top, width, height * 0.18, 5);
  ctx.fill();
  ctx.fillStyle = "rgba(24,32,44,0.5)";
  roundRect(ctx, cx - 8, top + height * 0.055, 16, 5, 2.5);
  ctx.fill();

  // 标签带
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(cx - width / 2 + 3, bodyTop + bodyHeight * 0.4, width - 6, bodyHeight * 0.26);
  ctx.fillStyle = drink.color;
  ctx.font = `800 10px ${JP_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(drink.text, cx, bodyTop + bodyHeight * 0.535);

  // 竖向高光
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  roundRect(ctx, cx - width / 2 + 5, bodyTop + 8, 5, bodyHeight * 0.62, 2.5);
  ctx.fill();

  // 热饮机贴 HOT 小标
  if (hot) {
    ctx.fillStyle = "#c0392b";
    roundRect(ctx, cx - width / 2 + 2, bodyTop + 4, 20, 11, 3);
    ctx.fill();
    ctx.fillStyle = "#fff4ea";
    ctx.font = `800 8px ${JP_FONT}`;
    ctx.fillText("HOT", cx - width / 2 + 12, bodyTop + 10);
  }
}

function drawPriceTag(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  price: string,
): void {
  ctx.fillStyle = "rgba(244,248,252,0.94)";
  roundRect(ctx, cx - 21, y, 42, 22, 4);
  ctx.fill();
  ctx.fillStyle = "#b23b3b";
  ctx.font = `800 15px ${JP_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(price, cx, y + 12);
}

/**
 * 贩卖机正面整面灯箱贴图（宽高比 = 0.95 : 1.85）。
 * 画：顶部灯箱字 → 3 排 × 4 列饮料 + 价格 → 按键排 → 投币/纸币/刷卡面板 → 取物口。
 */
export function createVendingFrontTexture(variant: VendingVariant): THREE.CanvasTexture {
  const look = VENDING_LOOKS[variant];
  const drinks = variant === "cool" ? COOL_DRINKS : WARM_DRINKS;
  return canvasTexture(512, 1000, (ctx, w, h) => {
    // 机身底色（带一点上亮下暗，模拟灯箱外框受光）
    const bodyGradient = ctx.createLinearGradient(0, 0, 0, h);
    bodyGradient.addColorStop(0, mixHex(look.body, "#ffffff", 0.16));
    bodyGradient.addColorStop(0.55, look.body);
    bodyGradient.addColorStop(1, mixHex(look.body, "#000000", 0.18));
    ctx.fillStyle = bodyGradient;
    ctx.fillRect(0, 0, w, h);

    // 前门钢板：内嵌一圈淡色边
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRect(ctx, 10, 8, 492, 982, 16);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 3;
    roundRect(ctx, 12, 10, 488, 978, 15);
    ctx.stroke();

    // 顶部灯箱：冷 / 热 大字
    const headerGradient = ctx.createLinearGradient(0, 18, 0, 92);
    headerGradient.addColorStop(0, mixHex(look.header, "#ffffff", 0.2));
    headerGradient.addColorStop(1, look.header);
    ctx.fillStyle = headerGradient;
    roundRect(ctx, 22, 18, 468, 76, 9);
    ctx.fill();
    ctx.fillStyle = look.headerInk;
    ctx.font = `800 44px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(look.label, w / 2, 58);
    ctx.fillStyle = "rgba(255,255,255,0.34)";
    ctx.fillRect(34, 24, 444, 3);

    // 展示窗（深色玻璃）
    const glassGradient = ctx.createLinearGradient(0, 104, 0, 660);
    glassGradient.addColorStop(0, "#131e2c");
    glassGradient.addColorStop(1, "#070c14");
    ctx.fillStyle = glassGradient;
    roundRect(ctx, 20, 104, 472, 552, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(18,26,38,0.95)";
    ctx.lineWidth = 5;
    roundRect(ctx, 20, 104, 472, 552, 6);
    ctx.stroke();

    // 3 排 × 4 列
    const rowTop = 112;
    const rowHeight = 178;
    for (let row = 0; row < 3; row += 1) {
      const top = rowTop + row * rowHeight;
      for (let col = 0; col < 4; col += 1) {
        const cx = 20 + 59 + col * 118;
        drawCan(ctx, cx, top + 34, drinks[row][col], look.hot);
        drawPriceTag(ctx, cx, top + 146, drinks[row][col].price);
      }
      // 货架横梁
      ctx.fillStyle = "#2c3a4d";
      ctx.fillRect(26, top + 172, 460, 5);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(26, top + 172, 460, 2);
    }

    // 玻璃斜向反光
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#dff6ff";
    ctx.beginPath();
    ctx.moveTo(96, 650);
    ctx.lineTo(292, 104);
    ctx.lineTo(360, 104);
    ctx.lineTo(164, 650);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 按键排：4 个大按钮 + 价格提示
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    roundRect(ctx, 24, 664, 464, 76, 9);
    ctx.fill();
    for (let col = 0; col < 4; col += 1) {
      const cx = 20 + 59 + col * 118;
      const cy = 702;
      const buttonColors =
        variant === "cool"
          ? [look.accent, "#3f86b5", "#d8e2ee", "#4b9a86"]
          : ["#e8963f", "#d8cfa8", "#e6e2d4", "#c0392b"];
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.arc(cx, cy + 2, 21, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = buttonColors[col];
      ctx.beginPath();
      ctx.arc(cx, cy, 19, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 19, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(12,18,28,0.72)";
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `700 15px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      variant === "cool" ? "つめた〜い" : "あったか〜い",
      w / 2,
      728,
    );

    // 支付面板：投币 / 纸币 / 退币 / 刷卡
    ctx.fillStyle = "#1b2430";
    roundRect(ctx, 24, 750, 206, 110, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    roundRect(ctx, 26, 752, 202, 106, 6);
    ctx.stroke();
    // 硬币口
    ctx.fillStyle = "#05080d";
    roundRect(ctx, 44, 772, 12, 52, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `700 13px ${JP_FONT}`;
    ctx.textAlign = "left";
    ctx.fillText("硬貨", 62, 790);
    // 纸币口
    ctx.fillStyle = "#05080d";
    roundRect(ctx, 62, 806, 104, 12, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText("紙幣", 62, 836);
    // 指示灯
    ctx.fillStyle = look.accent;
    ctx.beginPath();
    ctx.arc(204, 786, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7fd6a8";
    ctx.beginPath();
    ctx.arc(204, 820, 5, 0, Math.PI * 2);
    ctx.fill();

    // 退币 / 返却
    ctx.fillStyle = look.bodyShade;
    roundRect(ctx, 242, 750, 102, 110, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `800 20px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("返却", 293, 790);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(270, 824);
    ctx.lineTo(300, 824);
    ctx.lineTo(292, 816);
    ctx.moveTo(300, 824);
    ctx.lineTo(292, 832);
    ctx.stroke();

    // 刷卡 / IC
    ctx.fillStyle = "#1b2430";
    roundRect(ctx, 356, 750, 132, 110, 7);
    ctx.fill();
    ctx.fillStyle = "#05080d";
    roundRect(ctx, 370, 774, 104, 34, 4);
    ctx.fill();
    ctx.fillStyle = look.accent;
    roundRect(ctx, 370, 820, 104, 8, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `700 12px ${JP_FONT}`;
    ctx.fillText("IC CARD", 422, 844);

    // 取物口
    ctx.fillStyle = "#070b12";
    roundRect(ctx, 24, 872, 464, 104, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 3;
    roundRect(ctx, 26, 874, 460, 100, 9);
    ctx.stroke();
    ctx.fillStyle = "#111a26";
    roundRect(ctx, 56, 906, 400, 46, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(56, 906, 400, 4);
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.font = `700 14px ${JP_FONT}`;
    ctx.textAlign = "right";
    ctx.fillText("取出口", 492, 968);

    // 底部：小字品牌 + 回收标
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 982, w, 18);
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.font = `700 13px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HIKARI DRINK  ·  RECYCLE", w / 2, 991);

    // 左右两侧高光边（灯箱边条）
    const edge = ctx.createLinearGradient(0, 0, 22, 0);
    edge.addColorStop(0, "rgba(255,255,255,0.2)");
    edge.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 8, 22, 976);
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.fillStyle = edge;
    ctx.fillRect(0, 8, 22, 976);
    ctx.restore();
  });
}

export type BinKind = "can" | "bottle" | "pet";

const BIN_LABELS: Record<BinKind, { word: string; romaji: string }> = {
  can: { word: "カン", romaji: "CAN" },
  bottle: { word: "ビン", romaji: "BOTTLE" },
  pet: { word: "ペット", romaji: "PET" },
};

/** 回收桶正面小标签（白底 + 彩色带 + 图标 + 日文） */
export function createBinLabelTexture(
  kind: BinKind,
  accent: string,
): THREE.CanvasTexture {
  const label = BIN_LABELS[kind];
  return canvasTexture(256, 192, (ctx, w, h) => {
    ctx.fillStyle = "#eef0e8";
    roundRect(ctx, 0, 0, w, h, 14);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    roundRect(ctx, 5, 5, w - 10, h - 10, 11);
    ctx.stroke();
    ctx.fillStyle = accent;
    roundRect(ctx, 5, 5, w - 10, 26, 10);
    ctx.fill();

    // 图标：罐 / 瓶 / PET 瓶
    ctx.save();
    ctx.fillStyle = accent;
    ctx.translate(w / 2, 58);
    if (kind === "can") {
      roundRect(ctx, -17, -18, 34, 40, 6);
      ctx.fill();
      ctx.fillStyle = "#eef0e8";
      ctx.fillRect(-17, -6, 34, 3);
      ctx.fillStyle = accent;
      roundRect(ctx, -6, -24, 12, 8, 3);
      ctx.fill();
    } else if (kind === "bottle") {
      roundRect(ctx, -11, -26, 22, 12, 3);
      ctx.fill();
      roundRect(ctx, -14, -16, 28, 38, 8);
      ctx.fill();
      ctx.fillStyle = "#eef0e8";
      ctx.fillRect(-14, 0, 28, 3);
    } else {
      roundRect(ctx, -7, -26, 14, 8, 2);
      ctx.fill();
      roundRect(ctx, -10, -18, 20, 36, 6);
      ctx.fill();
      ctx.fillStyle = "#eef0e8";
      for (let i = 0; i < 3; i += 1) {
        ctx.fillRect(-10, -8 + i * 10, 20, 3);
      }
    }
    ctx.restore();

    ctx.fillStyle = "#1b2430";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${label.word.length > 2 ? 46 : 54}px ${JP_FONT}`;
    ctx.fillText(label.word, w / 2, 124);
    ctx.fillStyle = "rgba(27,36,48,0.55)";
    ctx.font = `700 20px ${JP_FONT}`;
    ctx.fillText(label.romaji, w / 2, 160);
  });
}
