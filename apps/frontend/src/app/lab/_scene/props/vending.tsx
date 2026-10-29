"use client";

import { useMemo } from "react";
import * as THREE from "three";

import { Power } from "../core/assembly";
import {
  Glow,
  GlowPuddle,
  ToonBox,
  ToonCylinder,
} from "../core/materials";

import { PALETTE, SIDEWALK, TIMING, type Vec3 } from "../core/scene-config";
import {
  createVendingFrontTexture,
  VENDING_LOOKS,
  type VendingVariant,
} from "./textures";

/**
 * 自动贩卖机（街角第二视觉焦点）。
 *
 * 本地坐标：正面朝 +z，机身 0.95(宽) × 1.85(高) × 0.72(深)，原点是机脚中心。
 * 摆到 ANCHOR.vending 时整体绕 y 旋转 -π/2 → 正面朝 −x（西侧路口）。
 *
 * 正面是一整块 canvas 灯箱；用透明 MeshBasicMaterial 画，这样 <Power> 能把
 * 它当成“灯”闪两下点亮（Power 只接管 transparent 的 basic material）。
 */

/** 灯箱面板：不透明但标记 transparent，让 <Power> 能驱动它的 opacity */
function LightboxPanel({ map }: { map: THREE.Texture }) {
  return (
    <mesh position={[0, 0.9, 0.366]}>
      <planeGeometry args={[0.92, 1.7]} />
      <meshBasicMaterial map={map} transparent opacity={1} toneMapped={false} />
    </mesh>
  );
}

/** 顶部灯条：薄薄一条自发光边，负责 Bloom 的那一下 */
function TopStrip({ color }: { color: string }) {
  return (
    <mesh position={[0, 1.805, 0.366]}>
      <planeGeometry args={[0.9, 0.026]} />
      <meshBasicMaterial color={color} transparent opacity={1} toneMapped={false} />
    </mesh>
  );
}

export function VendingMachine({
  variant,
  position,
  rotationY,
}: {
  variant: VendingVariant;
  position: Vec3;
  rotationY: number;
}) {
  const look = VENDING_LOOKS[variant];
  const frontTexture = useMemo(() => createVendingFrontTexture(variant), [variant]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* 底部踢脚 */}
      <ToonBox
        size={[0.9, 0.05, 0.7]}
        position={[0, 0.025, 0]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />

      {/* 机身 */}
      <ToonBox
        size={[0.95, 1.74, 0.72]}
        position={[0, 0.92, 0]}
        color={look.body}
        outline={0.02}
      />

      {/* 侧板细节（默认机位主要看到 +x 侧面，当作品牌侧灯箱来做） */}
      <ToonBox
        size={[0.012, 0.98, 0.5]}
        position={[0.48, 1.2, 0]}
        color={look.bodyShade}
        outline={0}
      />
      {/* 侧面品牌色带 + 细白线 */}
      <ToonBox
        size={[0.016, 0.26, 0.62]}
        position={[0.483, 1.47, 0]}
        color={look.accent}
        outline={0}
      />
      <ToonBox
        size={[0.018, 0.028, 0.62]}
        position={[0.485, 1.31, 0]}
        color={PALETTE.cream}
        outline={0}
      />
      {/* 侧面圆标 */}
      <ToonCylinder
        radiusTop={0.085}
        radiusBottom={0.085}
        height={0.014}
        radialSegments={16}
        position={[0.492, 1.47, 0]}
        rotation={[0, 0, Math.PI / 2]}
        color={PALETTE.cream}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.044}
        radiusBottom={0.044}
        height={0.012}
        radialSegments={12}
        position={[0.5, 1.47, 0]}
        rotation={[0, 0, Math.PI / 2]}
        color={look.accent}
        outline={0}
      />
      {/* 侧面检修门 + 锁 + 散热格栅 */}
      <ToonBox
        size={[0.014, 0.36, 0.3]}
        position={[0.481, 0.82, 0.03]}
        color={look.bodyShade}
        outline={0.006}
      />
      <ToonCylinder
        radiusTop={0.013}
        radiusBottom={0.013}
        height={0.016}
        radialSegments={8}
        position={[0.49, 0.68, -0.08]}
        rotation={[0, 0, Math.PI / 2]}
        color={PALETTE.metal}
        outline={0}
      />
      {[0, 1, 2, 3].map((i) => (
        <ToonBox
          key={i}
          size={[0.012, 0.016, 0.2]}
          position={[0.482, 0.3 + i * 0.042, -0.16]}
          color={PALETTE.darkMetal}
          outline={0}
        />
      ))}
      {/* 顶部防雨罩 */}
      <ToonBox
        size={[1.0, 0.06, 0.77]}
        position={[0, 1.82, 0]}
        color={look.bodyShade}
        outline={0.018}
      />

      {/* 取物口伸出的金属唇边 */}
      <ToonBox
        size={[0.62, 0.035, 0.06]}
        position={[0, 0.135, 0.385]}
        color={PALETTE.darkMetal}
        outline={0.008}
      />

      {/* 发光的正面 + 顶部灯条 + 光晕，全部走 Power */}
      <Power delay={TIMING.power + 0.4}>
        <LightboxPanel map={frontTexture} />
        <TopStrip color={look.glow} />
        <Glow
          color={look.glow}
          size={2.1}
          opacity={0.3}
          position={[0, 0.95, 0.62]}
        />
      </Power>
    </group>
  );
}

/** 两台并排（冷饮机 + 热饮机），共用地面光斑 */
export function VendingGroundGlow() {
  return (
    <Power delay={TIMING.power + 0.4}>
      <Glow
        color={PALETTE.neonCyan}
        size={2.6}
        opacity={0.16}
        position={[-2.95, 1.15, -2.13]}
      />
      <GlowPuddle
        color={PALETTE.neonCyan}
        size={2.4}
        opacity={0.34}
        position={[-2.86, SIDEWALK.topY + 0.008, -2.13]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
    </Power>
  );
}
