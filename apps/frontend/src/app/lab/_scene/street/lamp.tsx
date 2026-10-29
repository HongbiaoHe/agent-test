"use client";

import {
  Glow,
  GlowPuddle,
  NeonPanel,
  ToonBox,
  ToonCylinder,
} from "../core/materials";
import { PALETTE } from "../core/scene-config";

/**
 * 街角路灯（暖钠灯）。
 *
 * 核心 spotLight 在 (3.35, 4.15, 2.3)，灯头组件全部对齐这个点：
 * 发光面朝下、灯罩在光源上方（不挡光），暖色 Glow 包在 Power 里做点亮闪烁。
 */

const LAMP_X = 3.35;
const LAMP_Z = 2.28;
const BASE_Y = 0.18;

export function StreetLamp() {
  return (
    <group>
      {/* 灯座 */}
      <ToonCylinder
        radiusTop={0.2}
        radiusBottom={0.23}
        height={0.16}
        radialSegments={14}
        color={PALETTE.darkMetal}
        position={[LAMP_X, BASE_Y + 0.08, LAMP_Z]}
        outline={0.01}
      />
      {/* 灯杆 */}
      <ToonCylinder
        radiusTop={0.058}
        radiusBottom={0.095}
        height={3.66}
        radialSegments={12}
        color={PALETTE.cream}
        position={[LAMP_X, BASE_Y + 0.16 + 1.83, LAMP_Z]}
        outline={0.012}
      />
      {/* 灯头颈部（顶面 4.13，低于光源 4.15，不遮挡向下光锥） */}
      <ToonCylinder
        radiusTop={0.085}
        radiusBottom={0.062}
        height={0.13}
        radialSegments={10}
        color={PALETTE.metal}
        position={[LAMP_X, 4.065, LAMP_Z]}
        outline={0.008}
      />
      {/* 灯罩 */}
      <ToonBox
        size={[0.5, 0.14, 0.5]}
        position={[LAMP_X, 4.23, LAMP_Z]}
        color={PALETTE.darkMetal}
        outline={0.014}
      />
      <ToonBox
        size={[0.58, 0.05, 0.58]}
        position={[LAMP_X, 4.325, LAMP_Z]}
        color={PALETTE.metal}
        outline={0.01}
      />
      {/* 发光底面（不受光，Power 会把它点亮/闪烁） */}
      <NeonPanel
        width={0.42}
        height={0.42}
        color={PALETTE.lampWarm}
        opacity={0.95}
        position={[LAMP_X, 4.145, LAMP_Z]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      {/* 灯头空气光晕 + 地面暖光斑 */}
      <Glow
        color={PALETTE.lampWarm}
        size={2.6}
        opacity={0.5}
        position={[LAMP_X, 4.02, LAMP_Z]}
      />
      <GlowPuddle
        color={PALETTE.lampWarm}
        size={3}
        opacity={0.15}
        position={[LAMP_X, BASE_Y + 0.012, LAMP_Z]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
    </group>
  );
}
