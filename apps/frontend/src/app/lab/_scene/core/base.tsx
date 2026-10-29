"use client";

import { Outlines, RoundedBox } from "@react-three/drei";
import { Part } from "./assembly";
import { GlowPuddle, OUTLINE_COLOR, Toon } from "./materials";
import { BASE, PALETTE, TIMING } from "./scene-config";

/**
 * 正方形展示底座（微缩模型的"收藏级"底盘）。
 * 顶面 y=0；四周做了一圈薄薄的亮边，底部有很淡的台面辉光，
 * 让整个模型看起来是"放在展台上"，而不是浮在空中。
 */
export function Base() {
  return (
    <Part delay={TIMING.base} duration={0.6} distance={1.2}>
      <RoundedBox
        args={[BASE.size, BASE.thickness, BASE.size]}
        radius={BASE.cornerRadius}
        smoothness={3}
        position={[0, -BASE.thickness / 2, 0]}
        castShadow
        receiveShadow
      >
        <Toon color={PALETTE.base} />
        <Outlines thickness={0.035} color={OUTLINE_COLOR} />
      </RoundedBox>

      {/* 台面一圈略亮的斜面边 */}
      <mesh position={[0, -0.055, 0]} receiveShadow>
        <boxGeometry args={[BASE.size + 0.02, 0.055, BASE.size + 0.02]} />
        <Toon color={PALETTE.baseRim} />
      </mesh>

      {/* 底边极细的一道冷光线，强调模型轮廓 */}
      <mesh position={[0, -BASE.thickness + 0.035, 0]}>
        <boxGeometry args={[BASE.size + 0.015, 0.012, BASE.size + 0.015]} />
        <meshBasicMaterial color={PALETTE.baseGlow} toneMapped={false} />
      </mesh>

      {/* 展台底部的柔和辉光 */}
      <GlowPuddle
        color={PALETTE.baseGlow}
        size={21}
        opacity={0.3}
        position={[0, -BASE.thickness - 0.012, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
    </Part>
  );
}
