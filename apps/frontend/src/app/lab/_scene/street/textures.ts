"use client";

import * as THREE from "three";

import { PALETTE } from "../core/scene-config";
import {
  canvasTexture,
  createTextPanelTexture,
  mixHex,
  JP_FONT,
  roundRect,
} from "../core/textures";

/**
 * street 模块自用的程序化贴图（水沟盖板 / 井盖 / 暖帘 / 路牌 / 过街标志）。
 * 全部走 core/textures 的 canvasTexture，不另建一套绘制逻辑。
 */

/** 排水沟金属格栅：细横条 + 边框，长边沿贴图 v 方向 */
export function createGrateTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = PALETTE.gutter;
    ctx.fillRect(0, 0, w, h);

    // 外框
    ctx.strokeStyle = PALETTE.metal;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);

    // 竖向格栅条（沿 v 方向的缝隙）
    const slat = mixHex(PALETTE.metal, PALETTE.darkMetal, 0.35);
    for (let i = 0; i < 7; i += 1) {
      const x = 16 + i * 15;
      ctx.fillStyle = slat;
      ctx.fillRect(x, 14, 8, h - 28);
      ctx.fillStyle = "rgba(200, 220, 255, 0.16)";
      ctx.fillRect(x, 14, 2, h - 28);
    }
  });
}

/** 井盖：同心圆环 + 放射纹 + 中心螺栓 */
export function createManholeTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const disc = ctx.createRadialGradient(cx, cy, 8, cx, cy, 124);
    disc.addColorStop(0, "#2a3444");
    disc.addColorStop(0.7, "#1b2331");
    disc.addColorStop(1, "#141a26");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, 124, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = mixHex(PALETTE.metal, PALETTE.white, 0.12);
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, 112, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = mixHex(PALETTE.metal, PALETTE.darkMetal, 0.2);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 92, 0, Math.PI * 2);
    ctx.stroke();

    // 放射防滑纹
    for (let i = 0; i < 28; i += 1) {
      const angle = (i / 28) * Math.PI * 2;
      ctx.strokeStyle =
        i % 2 === 0
          ? mixHex(PALETTE.metal, PALETTE.darkMetal, 0.15)
          : PALETTE.darkMetal;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * 44, cy + Math.sin(angle) * 44);
      ctx.lineTo(cx + Math.cos(angle) * 86, cy + Math.sin(angle) * 86);
      ctx.stroke();
    }

    ctx.fillStyle = mixHex(PALETTE.metal, PALETTE.white, 0.2);
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.darkMetal;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** 小巷入口暖帘（一片 = 一个字，藏青布 + 白字 + 家纹） */
export function createNorenTexture(char: string): THREE.CanvasTexture {
  return canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = "#1f2c47";
    ctx.fillRect(0, 0, w, h);

    const cloth = ctx.createLinearGradient(0, 0, w, h);
    cloth.addColorStop(0, "rgba(255, 255, 255, 0.08)");
    cloth.addColorStop(0.55, "rgba(255, 255, 255, 0)");
    cloth.addColorStop(1, "rgba(0, 0, 0, 0.28)");
    ctx.fillStyle = cloth;
    ctx.fillRect(0, 0, w, h);

    // 家纹圆圈
    ctx.strokeStyle = "rgba(222, 232, 246, 0.62)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.17, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(222, 232, 246, 0.5)";
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.17, 10, 0, Math.PI * 2);
    ctx.fill();

    // 白字
    ctx.fillStyle = "#e9eef7";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 186px ${JP_FONT}`;
    ctx.fillText(char, w / 2, h * 0.56);

    // 下摆压深
    ctx.fillStyle = "rgba(0, 0, 0, 0.26)";
    ctx.fillRect(0, h - 46, w, 46);
    ctx.fillStyle = "rgba(222, 232, 246, 0.35)";
    ctx.fillRect(0, h - 52, w, 6);
  });
}

/** 电线杆上的蓝底白字町名牌 */
export function createStreetNameTexture(): THREE.CanvasTexture {
  return createTextPanelTexture({
    width: 512,
    height: 196,
    bg: "#1e3352",
    border: "#e6eef9",
    borderWidth: 7,
    padding: 22,
    lines: [
      { text: "桜町 2丁目", size: 74, color: "#f3f7fd" },
      { text: "Sakura-machi 2", size: 34, color: "#c3d5ea" },
    ],
  });
}

/** 电线杆的小号牌 */
export function createPoleNumberTexture(): THREE.CanvasTexture {
  return createTextPanelTexture({
    width: 160,
    height: 120,
    bg: "#e8eef6",
    border: "#2a3348",
    borderWidth: 6,
    padding: 10,
    lines: [
      { text: "桜町", size: 28, color: "#232c3d" },
      { text: "2-14", size: 34, color: "#232c3d" },
    ],
  });
}

/** 斑马线旁的行人过街标志（蓝底白色行人 + 斑马条） */
export function createCrossingSignTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#1f4c86";
    roundRect(ctx, 0, 0, w, h, 20);
    ctx.fill();

    ctx.strokeStyle = "#eef4fc";
    ctx.lineWidth = 9;
    roundRect(ctx, 15, 15, w - 30, h - 30, 13);
    ctx.stroke();

    // 斑马条
    ctx.fillStyle = "#eef4fc";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(58 + i * 36, 184, 22, 34);
    }

    // 行人
    ctx.strokeStyle = "#eef4fc";
    ctx.fillStyle = "#eef4fc";
    ctx.lineCap = "round";
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.arc(133, 66, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(129, 88);
    ctx.lineTo(121, 142);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(121, 142);
    ctx.lineTo(101, 180);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(121, 142);
    ctx.lineTo(147, 178);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(127, 106);
    ctx.lineTo(157, 126);
    ctx.stroke();
  });
}

/** 过街标志下方的辅助文字牌 */
export function createCrossingSubTexture(): THREE.CanvasTexture {
  return createTextPanelTexture({
    width: 384,
    height: 96,
    bg: "#eef4fc",
    border: "#1f4c86",
    borderWidth: 6,
    padding: 12,
    lines: [{ text: "横断歩道", size: 46, color: "#1f4c86" }],
  });
}
