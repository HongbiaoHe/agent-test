"use client";

import { useMemo } from "react";

import { GlassPanel, NeonPanel, Toon, ToonBox } from "../core/materials";
import {
  createMatTexture,
  createPosterTexture,
  createTextPanelTexture,
} from "../core/textures";
import { ANCHOR, PALETTE } from "../core/scene-config";
import { D, GLASS_CY, GLASS_H } from "./dims";

/**
 * 南立面 / 西立面橱窗：踢脚、白色竖梃、玻璃、海报、斜向高光，
 * 以及南立面的双扇自动门（一扇略开）与门口地垫。
 */

const DOOR_Z = D.doorZ;
const GLASS_Z = D.glassZ;
/** 南立面玻璃分格 */
const WEST_BAY: [number, number] = [-1.6, 0.12];
const EAST_BAY: [number, number] = [1.78, 4.0];
/** 西立面橱窗 z 范围（前半段） */
const WEST_Z: [number, number] = [-2.9, -0.8];

function DoorLeaf({ centerX, z }: { centerX: number; z: number }) {
  const w = 0.78;
  const bottom = 0.24;
  const top = 2.36;
  const h = top - bottom;
  const cy = (top + bottom) / 2;
  return (
    <group>
      <GlassPanel width={w - 0.1} height={h - 0.19} position={[centerX, cy, z]} opacity={0.13} />
      <ToonBox
        size={[w, 0.14, 0.06]}
        position={[centerX, bottom + 0.07, z + 0.012]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonBox
        size={[w, 0.09, 0.06]}
        position={[centerX, top - 0.045, z + 0.012]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonBox
        size={[0.05, h, 0.06]}
        position={[centerX - w / 2 + 0.025, cy, z + 0.012]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonBox
        size={[0.05, h, 0.06]}
        position={[centerX + w / 2 - 0.025, cy, z + 0.012]}
        color={PALETTE.metal}
        outline={0.012}
      />
    </group>
  );
}

export function Storefront() {
  const posters = useMemo(
    () => [
      createPosterTexture({
        title: "新発売",
        subtitle: "HIKARI カフェ",
        bg: "#f2e7cf",
        accent: PALETTE.brandAlt,
        badge: "NEW",
      }),
      createPosterTexture({
        title: "からあげ",
        subtitle: "揚げたて 100円",
        bg: "#efe3c9",
        accent: PALETTE.neonPink,
        badge: "HOT",
      }),
      createPosterTexture({
        title: "24時間",
        subtitle: "いつでも あいてます",
        bg: "#e9e5d6",
        accent: PALETTE.brand,
        badge: "OPEN",
      }),
    ],
    [],
  );

  const autoDoorSticker = useMemo(
    () =>
      createTextPanelTexture({
        width: 384,
        height: 160,
        bg: PALETTE.brand,
        border: "#ffffff",
        borderWidth: 8,
        radius: 18,
        lines: [{ text: "自動ドア", size: 72, color: "#ffffff", weight: 800 }],
      }),
    [],
  );
  const hoursSticker = useMemo(
    () =>
      createTextPanelTexture({
        width: 512,
        height: 128,
        bg: "#f0e9d6",
        border: PALETTE.brand,
        borderWidth: 8,
        radius: 14,
        lines: [{ text: "24時間営業", size: 62, color: PALETTE.brandInk, weight: 800 }],
      }),
    [],
  );
  const matTexture = useMemo(() => createMatTexture(), []);

  const westBayW = WEST_BAY[1] - WEST_BAY[0];
  const eastBayW = EAST_BAY[1] - EAST_BAY[0];
  const westBayX = (WEST_BAY[0] + WEST_BAY[1]) / 2;
  const eastBayX = (EAST_BAY[0] + EAST_BAY[1]) / 2;
  const westZW = WEST_Z[1] - WEST_Z[0];
  const westZ = (WEST_Z[0] + WEST_Z[1]) / 2;

  const mullionY = (D.kickTopY + D.glassTopY) / 2;
  const mullionH = D.glassTopY - D.kickTopY;

  return (
    <group>
      {/* ── 踢脚板（深色） ── */}
      <ToonBox
        size={[westBayW, 0.35, D.wallT]}
        position={[westBayX, D.floorY + 0.175, D.southCZ]}
        color={PALETTE.darkMetal}
        outline={0.02}
      />
      <ToonBox
        size={[eastBayW, 0.35, D.wallT]}
        position={[eastBayX, D.floorY + 0.175, D.southCZ]}
        color={PALETTE.darkMetal}
        outline={0.02}
      />
      <ToonBox
        size={[D.wallT, 0.35, westZW]}
        position={[D.westCX, D.floorY + 0.175, westZ]}
        color={PALETTE.darkMetal}
        outline={0.02}
      />
      {/* 踢脚上沿金属压条 */}
      <ToonBox
        size={[westBayW, 0.035, 0.19]}
        position={[westBayX, D.kickTopY - 0.005, D.z1 - 0.07]}
        color={PALETTE.metal}
        outline={0}
      />
      <ToonBox
        size={[eastBayW, 0.035, 0.19]}
        position={[eastBayX, D.kickTopY - 0.005, D.z1 - 0.07]}
        color={PALETTE.metal}
        outline={0}
      />
      <ToonBox
        size={[0.19, 0.035, westZW]}
        position={[D.x0 + 0.09, D.kickTopY - 0.005, westZ]}
        color={PALETTE.metal}
        outline={0}
      />

      {/* ── 白色竖梃 ── */}
      {[-1.6, -0.74, 0.12, 1.78, 2.89, 4.0].map((x) => (
        <ToonBox
          key={`m-${x}`}
          size={[0.07, mullionH, 0.17]}
          position={[x, mullionY, D.z1 - 0.075]}
          color={PALETTE.storeTrim}
          outline={0.014}
        />
      ))}
      {[-2.9, -1.85, -0.8].map((z) => (
        <ToonBox
          key={`w-${z}`}
          size={[0.17, mullionH, 0.07]}
          position={[D.x0 + 0.085, mullionY, z]}
          color={PALETTE.storeTrim}
          outline={0.014}
        />
      ))}

      {/* ── 玻璃 ── */}
      <GlassPanel
        width={westBayW - 0.06}
        height={GLASS_H - 0.02}
        position={[westBayX, GLASS_CY, GLASS_Z]}
        opacity={0.16}
      />
      <GlassPanel
        width={eastBayW - 0.06}
        height={GLASS_H - 0.02}
        position={[eastBayX, GLASS_CY, GLASS_Z]}
        opacity={0.16}
      />
      <GlassPanel
        width={westZW - 0.06}
        height={GLASS_H - 0.02}
        position={[D.x0 + 0.085, GLASS_CY, westZ]}
        rotation={[0, -Math.PI / 2, 0]}
        opacity={0.16}
      />

      {/* 斜向反光高光：一条薄白光带，模拟玻璃上的环境反射 */}
      <NeonPanel
        width={2.0}
        height={0.045}
        color="#e8f2f6"
        opacity={0.2}
        position={[2.9, 1.86, D.z1 - 0.045]}
        rotation={[0, 0, -0.62]}
      />
      <NeonPanel
        width={1.5}
        height={0.04}
        color="#e8f2f6"
        opacity={0.17}
        position={[-1.745, 1.92, -1.6]}
        rotation={[0, -Math.PI / 2, -0.55]}
      />

      {/* ── 窗上海报（贴在玻璃外侧，稍微压暗当作印刷品） ── */}
      <NeonPanel
        width={0.44}
        height={0.62}
        map={posters[0]}
        color="#c8c6ba"
        position={[-1.18, 1.46, D.z1 - 0.038]}
      />
      <NeonPanel
        width={0.36}
        height={0.5}
        map={posters[1]}
        color="#c8c6ba"
        position={[-0.48, 1.52, D.z1 - 0.038]}
        rotation={[0, 0, 0.05]}
      />
      <NeonPanel
        width={0.4}
        height={0.56}
        map={posters[2]}
        color="#c8c6ba"
        position={[-1.752, 1.38, -1.35]}
        rotation={[0, -Math.PI / 2, 0]}
      />

      {/* ── 自动门 ── */}
      <ToonBox
        size={[1.72, 0.1, 0.18]}
        position={[0.95, 2.42, D.z1 - 0.075]}
        color={PALETTE.metal}
        outline={0.012}
      />
      {/* 左扇（关闭） */}
      <DoorLeaf centerX={0.55} z={DOOR_Z} />
      {/* 右扇（向右错开 0.08，露出门缝） */}
      <DoorLeaf centerX={1.43} z={DOOR_Z} />
      {/* 门把手 */}
      <ToonBox
        size={[0.03, 0.55, 0.04]}
        position={[0.9, 1.12, DOOR_Z + 0.03]}
        color={PALETTE.metal}
        outline={0}
      />
      <ToonBox
        size={[0.03, 0.55, 0.04]}
        position={[1.1, 1.12, DOOR_Z + 0.03]}
        color={PALETTE.metal}
        outline={0}
      />
      {/* 门贴 */}
      <NeonPanel
        width={0.34}
        height={0.145}
        map={autoDoorSticker}
        color="#c9c7bb"
        position={[1.33, 1.52, DOOR_Z + 0.024]}
      />
      <NeonPanel
        width={0.3}
        height={0.078}
        map={hoursSticker}
        color="#c9c7bb"
        position={[0.5, 1.18, DOOR_Z + 0.024]}
      />
      {/* 门上方传感器 */}
      <ToonBox
        size={[0.52, 0.085, 0.13]}
        position={[0.95, 2.4, D.z1 - 0.02]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      <NeonPanel
        width={0.34}
        height={0.018}
        color="#7be6d3"
        opacity={0.9}
        position={[0.95, 2.365, D.z1 + 0.048]}
      />
      {/* 门槛 */}
      <ToonBox
        size={[1.66, 0.025, 0.22]}
        position={[0.95, D.floorY + 0.012, D.z1 - 0.02]}
        color={PALETTE.metal}
        outline={0}
      />

      {/* ── 门口地垫 ── */}
      <mesh
        position={[ANCHOR.mat[0], ANCHOR.mat[1] + 0.012, ANCHOR.mat[2]]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[1.5, 0.95]} />
        <Toon color="#e4dfd2" map={matTexture} />
      </mesh>
    </group>
  );
}
