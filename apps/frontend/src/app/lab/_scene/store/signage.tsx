"use client";

import { useMemo } from "react";
import type { Texture } from "three";

import { Glow, GlowPuddle, NeonPanel, ToonBox, ToonCylinder } from "../core/materials";
import { canvasTexture, createStoreSignTexture } from "../core/textures";
import { PALETTE, TIMING } from "../core/scene-config";
import { Power } from "../core/assembly";
import { D } from "./dims";

/**
 * 门头：南立面主招牌带 + 西立面缩小版招牌带（同一张贴图），
 * 以及入口雨棚（帆布 + 品牌色前缘 + 支撑杆 + 暖光带）。
 * 招牌与雨棚灯都包在 <Power> 里，按时间轴依次通电。
 */

const SIGN_CY = (D.signBottomY + D.signTopY) / 2;
const SIGN_H = D.signTopY - D.signBottomY;

function SouthSign({ map }: { map: Texture }) {
  return (
    <group>
      <NeonPanel
        width={5.8}
        height={SIGN_H}
        map={map}
        opacity={0.97}
        position={[D.cx, SIGN_CY, D.z1 + 0.018]}
      />
      {/* 细边框 */}
      <ToonBox
        size={[5.94, 0.06, 0.08]}
        position={[D.cx, D.signTopY + 0.03, D.z1 + 0.012]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      <ToonBox
        size={[5.94, 0.06, 0.08]}
        position={[D.cx, D.signBottomY - 0.03, D.z1 + 0.012]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      <ToonBox
        size={[0.06, SIGN_H + 0.06, 0.08]}
        position={[D.cx - 2.9, SIGN_CY, D.z1 + 0.012]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      <ToonBox
        size={[0.06, SIGN_H + 0.06, 0.08]}
        position={[D.cx + 2.9, SIGN_CY, D.z1 + 0.012]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      {/* 招牌前的辉光 */}
      <Glow color="#ffeccd" size={1.25} opacity={0.12} position={[0.1, 2.82, -0.1]} />
      <Glow color="#ffeccd" size={1.15} opacity={0.1} position={[1.4, 2.82, -0.08]} />
      <Glow color="#ffeccd" size={1.25} opacity={0.12} position={[3.1, 2.82, -0.1]} />
    </group>
  );
}

function WestSign({ map }: { map: Texture }) {
  const panelWidth = 2.08;
  const panelHeight = 0.33;
  const centerZ = -1.85;
  const x = D.x0 - 0.014;
  const y = 2.74;
  return (
    <group>
      <NeonPanel
        width={panelWidth}
        height={panelHeight}
        map={map}
        opacity={0.96}
        position={[x, y, centerZ]}
        rotation={[0, -Math.PI / 2, 0]}
      />
      <ToonBox
        size={[0.08, 0.04, panelWidth + 0.06]}
        position={[x + 0.01, y + panelHeight / 2 + 0.02, centerZ]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <ToonBox
        size={[0.08, 0.04, panelWidth + 0.06]}
        position={[x + 0.01, y - panelHeight / 2 - 0.02, centerZ]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <ToonBox
        size={[0.08, panelHeight + 0.08, 0.04]}
        position={[x + 0.01, y, centerZ - panelWidth / 2 - 0.015]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <ToonBox
        size={[0.08, panelHeight + 0.08, 0.04]}
        position={[x + 0.01, y, centerZ + panelWidth / 2 + 0.015]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <Glow color="#ffeccd" size={1.4} opacity={0.13} position={[D.x0 - 0.22, y, centerZ]} />
    </group>
  );
}

export function Signage() {
  const signTexture = useMemo(() => createStoreSignTexture(), []);
  return (
    <Power delay={TIMING.power + 0.7}>
      <SouthSign map={signTexture} />
      <WestSign map={signTexture} />
    </Power>
  );
}

/**
 * 雨棚帆布贴图：暗一档的奶油色 + 拼缝 + 前缘品牌色横带。
 * canvas 底部 = 贴图 v=0 = 雨棚前缘。
 */
function createAwningTexture(): Texture {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#cdc3ac");
    grad.addColorStop(0.7, "#dcd2ba");
    grad.addColorStop(1, "#e5dbc2");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 帆布拼缝
    ctx.strokeStyle = "rgba(92, 80, 62, 0.22)";
    ctx.lineWidth = 3;
    for (let i = 1; i < 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo((w / 6) * i, 0);
      ctx.lineTo((w / 6) * i, h);
      ctx.stroke();
    }

    // 前缘品牌色横带（这条带子同时也是雨棚的视觉前缘）
    ctx.fillStyle = PALETTE.brand;
    ctx.fillRect(0, h - 44, w, 28);
    ctx.fillStyle = PALETTE.brandAlt;
    ctx.fillRect(0, h - 14, w, 8);
    // 靠墙一侧的细品牌线
    ctx.fillStyle = "rgba(47, 200, 165, 0.5)";
    ctx.fillRect(0, 0, w, 5);
  });
}

/** 入口雨棚：x -0.7~2.55，从墙面 z=-0.6 伸到 z≈0.52，前低后高。 */
export function Awning() {
  const awningTexture = useMemo(() => createAwningTexture(), []);
  const x0 = -0.7;
  const x1 = 2.55;
  const cx = (x0 + x1) / 2;
  const width = x1 - x0;
  const canopyCY = 2.4;
  const canopyTilt = 0.084;
  const depth = 1.16;
  const frontZ = -0.04 + (depth / 2) * Math.cos(canopyTilt);
  const frontY = canopyCY - (depth / 2) * Math.sin(canopyTilt);

  // 支撑杆：从雨棚前角斜拉回墙面
  const rodDx = 0;
  const rodDz = frontZ - (D.z1 - 0.02);
  const rodDy = 2.5 - (frontY - 0.03);
  const rodLen = Math.hypot(rodDy, rodDz);
  const rodAngle = Math.atan2(rodDz, -rodDy);
  const rodMidY = (2.5 + (frontY - 0.03)) / 2;
  const rodMidZ = (D.z1 - 0.02 + frontZ) / 2;

  return (
    <group>
      {/* 帆布顶 */}
      <ToonBox
        size={[width, 0.06, depth]}
        position={[cx, canopyCY, -0.04]}
        rotation={[canopyTilt, 0, 0]}
        color={PALETTE.cream}
        outline={0.02}
      />
      {/* 帆布顶面：不受光贴图，保证夜里不被洗成一块死白 */}
      <NeonPanel
        width={width}
        height={depth}
        map={awningTexture}
        color="#b8b1a2"
        position={[cx, canopyCY + 0.04, -0.037]}
        rotation={[canopyTilt - Math.PI / 2, 0, 0]}
      />
      {/* 品牌色前缘条 + 橙色细线 */}
      <ToonBox
        size={[width + 0.04, 0.1, 0.06]}
        position={[cx, frontY - 0.055, frontZ - 0.01]}
        color={PALETTE.brand}
        outline={0.012}
      />
      <ToonBox
        size={[width + 0.04, 0.025, 0.055]}
        position={[cx, frontY - 0.115, frontZ - 0.01]}
        color={PALETTE.brandAlt}
        outline={0}
      />
      {/* 两根斜拉支撑杆 */}
      {[x0 + 0.14, x1 - 0.14].map((x) => (
        <ToonCylinder
          key={x}
          radiusTop={0.02}
          radiusBottom={0.02}
          height={rodLen}
          position={[x + rodDx, rodMidY, rodMidZ]}
          rotation={[rodAngle, 0, 0]}
          color={PALETTE.metal}
          outline={0.01}
        />
      ))}
      {/* 墙面固定件 */}
      {[x0 + 0.14, x1 - 0.14].map((x) => (
        <ToonBox
          key={`b-${x}`}
          size={[0.08, 0.09, 0.1]}
          position={[x, 2.5, D.z1 - 0.09]}
          color={PALETTE.darkMetal}
          outline={0.01}
        />
      ))}
      {/* 雨棚底面的暖光带（通电后亮起） */}
      <Power delay={TIMING.power + 0.95}>
        <NeonPanel
          width={width - 0.3}
          height={0.07}
          color="#ffd9a0"
          opacity={0.7}
          position={[cx, 2.345, 0.0]}
          rotation={[Math.PI / 2, 0, 0]}
        />
        <Glow color={PALETTE.warmLight} size={1.5} opacity={0.13} position={[0.0, 2.15, 0.24]} />
        <Glow color={PALETTE.warmLight} size={1.5} opacity={0.13} position={[1.85, 2.15, 0.24]} />
        <GlowPuddle
          color={PALETTE.warmLight}
          size={3.0}
          opacity={0.1}
          position={[cx, 0.203, 0.34]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
      </Power>
    </group>
  );
}
