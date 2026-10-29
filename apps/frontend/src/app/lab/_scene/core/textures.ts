"use client";

import * as THREE from "three";

import { PALETTE } from "./scene-config";

/**
 * 程序化 Canvas 贴图：招牌文字、海报、地砖等。
 * 场景是纯客户端的（ssr:false），所以这里直接用 document/canvas。
 */

export const JP_FONT =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","YuGothic",sans-serif';

type DrawFn = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

/** 创建一张 CanvasTexture（默认 sRGB） */
export function canvasTexture(
  width: number,
  height: number,
  draw: DrawFn,
  { repeat }: { repeat?: [number, number] } = {},
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
  }
  texture.needsUpdate = true;
  return texture;
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** 自动缩小字号以塞进 maxWidth */
export function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  family: string,
  weight: number | string = 700,
): number {
  let size = startSize;
  while (size > 8) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return size;
}

export type SignLine = {
  text: string;
  size: number;
  color: string;
  weight?: number | string;
  family?: string;
  align?: CanvasTextAlign;
  /** 行高倍率，默认 1.2 */
  lineHeight?: number;
  /** 字符间距（px） */
  spacing?: number;
};

/** 通用文字牌：按行垂直居中排版，适合路牌 / 店招 / 告示 */
export function createTextPanelTexture({
  width = 512,
  height = 256,
  bg = "#f5f0e4",
  border,
  borderWidth = 0,
  lines,
  padding = 24,
  align = "center",
  radius = 0,
}: {
  width?: number;
  height?: number;
  bg?: string;
  border?: string;
  borderWidth?: number;
  lines: SignLine[];
  padding?: number;
  align?: CanvasTextAlign;
  radius?: number;
}): THREE.CanvasTexture {
  return canvasTexture(width, height, (ctx, w, h) => {
    ctx.fillStyle = bg;
    if (radius > 0) {
      roundRect(ctx, 0, 0, w, h, radius);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, w, h);
    }
    if (border && borderWidth > 0) {
      ctx.strokeStyle = border;
      ctx.lineWidth = borderWidth;
      if (radius > 0) {
        roundRect(ctx, borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth, radius);
        ctx.stroke();
      } else {
        ctx.strokeRect(
          borderWidth / 2,
          borderWidth / 2,
          w - borderWidth,
          h - borderWidth,
        );
      }
    }
    // 垂直居中：先算总高
    const heights = lines.map((line) => {
      const family = line.family ?? JP_FONT;
      const size = fitFontSize(
        ctx,
        line.text,
        w - padding * 2,
        line.size,
        family,
        line.weight ?? 700,
      );
      return size * (line.lineHeight ?? 1.2);
    });
    const total = heights.reduce((a, b) => a + b, 0);
    let y = (h - total) / 2;
    lines.forEach((line, index) => {
      const size = heights[index] / (line.lineHeight ?? 1.2);
      const family = line.family ?? JP_FONT;
      ctx.font = `${line.weight ?? 700} ${size}px ${family}`;
      ctx.fillStyle = line.color;
      ctx.textAlign = line.align ?? align;
      ctx.textBaseline = "top";
      const x =
        (line.align ?? align) === "left"
          ? padding
          : (line.align ?? align) === "right"
            ? w - padding
            : w / 2;
      if (line.spacing && line.spacing > 0) {
        drawSpacedText(ctx, line.text, x, y + (heights[index] - size) / 2, line.spacing);
      } else {
        ctx.fillText(line.text, x, y + (heights[index] - size) / 2);
      }
      y += heights[index];
    });
  });
}

function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  const chars = Array.from(text);
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total =
    widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let cursor = x - total / 2;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = "left";
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cursor, y);
    cursor += widths[i] + spacing;
  });
  ctx.textAlign = previousAlign;
}

/** 便利店门头招牌（宽幅）：品牌字 + 三色细条 + 和文副标 */
export function createStoreSignTexture(): THREE.CanvasTexture {
  return canvasTexture(2048, 256, (ctx, w, h) => {
    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, "#f7f2e6");
    base.addColorStop(1, "#e8e0ce");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    // 顶部三色条（日式便利店经典视觉）
    const stripeH = 16;
    const stripes = [PALETTE.brand, PALETTE.brandAlt, PALETTE.brand];
    stripes.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, i * stripeH, w, stripeH);
    });

    // 左侧品牌徽标
    const badgeX = 72;
    const badgeY = 78;
    const badgeSize = 116;
    ctx.fillStyle = PALETTE.brand;
    roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 24);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 86px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 4);

    // 主品牌字
    ctx.fillStyle = PALETTE.brandInk;
    ctx.font = `800 104px ${JP_FONT}`;
    ctx.textAlign = "left";
    ctx.fillText("HIKARI MART", 224, badgeY + 58);
    ctx.fillStyle = "#6d746c";
    ctx.font = `600 40px ${JP_FONT}`;
    ctx.fillText("ひかりマート", 228, badgeY + 126);

    // 右侧 24 小时 + 和文
    ctx.textAlign = "right";
    ctx.fillStyle = PALETTE.brandAlt;
    ctx.font = `800 88px ${JP_FONT}`;
    ctx.fillText("24h", w - 76, badgeY + 54);
    ctx.fillStyle = "#5d645d";
    ctx.font = `700 36px ${JP_FONT}`;
    ctx.fillText("24時間営業", w - 76, badgeY + 116);
  });
}

/** 便利店立柱灯箱（竖幅，双面贴） */
export function createPylonTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 1024, (ctx, w, h) => {
    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, "#fdf8ec");
    base.addColorStop(1, "#e9e1cf");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = PALETTE.brand;
    ctx.fillRect(0, 0, w, 26);
    ctx.fillStyle = PALETTE.brandAlt;
    ctx.fillRect(0, 26, w, 14);

    ctx.fillStyle = PALETTE.brand;
    roundRect(ctx, w / 2 - 74, 86, 148, 148, 32);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 108px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", w / 2, 86 + 78);

    ctx.fillStyle = PALETTE.brandInk;
    ctx.font = `800 96px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("HIKARI", w / 2, 330);
    ctx.fillText("MART", w / 2, 438);

    ctx.fillStyle = "#6d746c";
    ctx.font = `600 42px ${JP_FONT}`;
    ctx.fillText("ひかりマート", w / 2, 530);

    ctx.fillStyle = PALETTE.brandAlt;
    ctx.font = `800 150px ${JP_FONT}`;
    ctx.fillText("24h", w / 2, 700);
    ctx.fillStyle = "#6d746c";
    ctx.font = `700 38px ${JP_FONT}`;
    ctx.fillText("OPEN 24 HOURS", w / 2, 806);

    ctx.strokeStyle = "rgba(20,50,45,0.18)";
    ctx.lineWidth = 6;
    roundRect(ctx, 16, 16, w - 32, h - 32, 18);
    ctx.stroke();
  });
}

/** 海报 / 促销小牌：色块 + 标题 + 假文字行 */
export function createPosterTexture({
  title,
  subtitle,
  bg = "#f4ecd9",
  accent = PALETTE.brandAlt,
  ink = "#20302c",
  badge,
  width = 240,
  height = 340,
}: {
  title: string;
  subtitle?: string;
  bg?: string;
  accent?: string;
  ink?: string;
  badge?: string;
  width?: number;
  height?: number;
}): THREE.CanvasTexture {
  return canvasTexture(width, height, (ctx, w, h) => {
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, w, h, 14);
    ctx.fill();

    ctx.fillStyle = accent;
    roundRect(ctx, 0, 0, w, h * 0.38, 14);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.24)";
    roundRect(ctx, 18, 18, w - 36, h * 0.38 - 36, 8);
    ctx.fill();

    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const titleSize = fitFontSize(ctx, title, w - 44, 52, JP_FONT, 800);
    ctx.font = `800 ${titleSize}px ${JP_FONT}`;
    ctx.fillText(title, w / 2, h * 0.19);

    if (subtitle) {
      ctx.fillStyle = "rgba(32,48,44,0.72)";
      ctx.font = `600 22px ${JP_FONT}`;
      ctx.fillText(subtitle, w / 2, h * 0.47);
    }

    // 假文字行（远看有排版感，近看不穿帮）
    ctx.fillStyle = "rgba(32,48,44,0.22)";
    for (let i = 0; i < 4; i += 1) {
      const lineWidth = w - 48 - (i === 3 ? 46 : 0);
      roundRect(ctx, 24, h * 0.56 + i * 30, lineWidth, 10, 5);
      ctx.fill();
    }

    if (badge) {
      ctx.fillStyle = accent;
      roundRect(ctx, w / 2 - 62, h - 78, 124, 50, 25);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `800 26px ${JP_FONT}`;
      ctx.fillText(badge, w / 2, h - 53);
    }
  });
}

/** 门口地垫 */
export function createMatTexture(): THREE.CanvasTexture {
  return canvasTexture(640, 384, (ctx, w, h) => {
    ctx.fillStyle = "#1f3b38";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#cfd8c7";
    ctx.lineWidth = 12;
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.fillStyle = "#7fd6bd";
    ctx.font = `800 92px ${JP_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("WELCOME", w / 2, h / 2 - 20);
    ctx.fillStyle = "#d9e2d1";
    ctx.font = `600 38px ${JP_FONT}`;
    ctx.fillText("ひかりマート", w / 2, h / 2 + 78);
    // 编织纹理
    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth = 2;
    for (let x = 24; x < w; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 24);
      ctx.lineTo(x, h - 24);
      ctx.stroke();
    }
  });
}

/** 人行道地砖纹理（0.6m 一块，带勾缝和轻微色差） */
export function createTileTexture(
  base = PALETTE.sidewalk,
  joint = PALETTE.sidewalkJoint,
  tiles = 4,
): THREE.CanvasTexture {
  const size = 512;
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      ctx.fillStyle = joint;
      ctx.fillRect(0, 0, w, h);
      const cell = w / tiles;
      const gap = 5;
      for (let row = 0; row < tiles; row += 1) {
        for (let col = 0; col < tiles; col += 1) {
          const shade = 0.92 + ((row * 7 + col * 13) % 5) * 0.018;
          ctx.fillStyle = mixHex(base, "#000000", 1 - shade);
          ctx.fillRect(
            col * cell + gap,
            row * cell + gap,
            cell - gap * 2,
            cell - gap * 2,
          );
          // 砖面细颗粒
          ctx.fillStyle = "rgba(255,255,255,0.035)";
          for (let i = 0; i < 6; i += 1) {
            ctx.fillRect(
              col * cell + 12 + ((i * 37) % (cell - 30)),
              row * cell + 12 + ((i * 53) % (cell - 30)),
              2,
              2,
            );
          }
        }
      }
    },
    { repeat: [1, 1] },
  );
}

/** 路面积水 / 湿沥青用的细噪点（灰度，作为粗糙度或 color 叠加） */
export function createNoiseTexture(
  base = "#151b2b",
  speck = "#1d2538",
  size = 256,
): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2200; i += 1) {
        const x = (i * 97.3) % w;
        const y = (i * 53.7) % h;
        const r = 0.4 + ((i * 31) % 10) / 12;
        ctx.fillStyle = i % 3 === 0 ? speck : "rgba(255,255,255,0.02)";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    { repeat: [4, 4] },
  );
}

/** 十六进制颜色混合（amount=0 → a，1 → b） */
export function mixHex(a: string, b: string, amount: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const t = Math.max(0, Math.min(1, amount));
  const channel = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const value = parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
