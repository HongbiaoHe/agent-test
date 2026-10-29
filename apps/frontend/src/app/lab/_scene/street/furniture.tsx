"use client";

import { useMemo } from "react";

import {
  NeonPanel,
  Toon,
  ToonBox,
  ToonCylinder,
} from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";
import { mixHex } from "../core/textures";

import {
  createCrossingSignTexture,
  createCrossingSubTexture,
} from "./textures";

/**
 * 街道小品：街角凸面镜、行人过街标志、白色钢管护栏、后巷低墙。
 * 位置与朝向按 ART-SPEC §3B；全部构件直接落地（y=0.18），不做悬浮。
 */

const BASE_Y = 0.18;

/* ------------------------------------------------------------ 凸面镜 */

export function TrafficMirror() {
  // 站在西南路口的转角上，镜面朝西南（-x/+z）看向来车
  return (
    <group position={[-3.46, 0, 2.68]} rotation={[0, -Math.PI / 4, 0]}>
      {/* 底座 */}
      <ToonCylinder
        radiusTop={0.1}
        radiusBottom={0.12}
        height={0.07}
        radialSegments={12}
        color={PALETTE.darkMetal}
        position={[0, BASE_Y + 0.035, 0]}
        outline={0.008}
      />
      {/* 立杆 */}
      <ToonCylinder
        radiusTop={0.04}
        radiusBottom={0.048}
        height={2.5}
        radialSegments={10}
        color={PALETTE.metal}
        position={[0, BASE_Y + 1.25, 0]}
        outline={0.012}
      />
      {/* 反光贴 */}
      <ToonCylinder
        radiusTop={0.052}
        radiusBottom={0.052}
        height={0.1}
        radialSegments={10}
        color={PALETTE.cream}
        position={[0, 1.82, 0]}
        outline={0}
      />
      {/* 镜背 */}
      <mesh position={[0, 2.42, 0.005]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.27, 0.27, 0.04, 20]} />
        <Toon color={PALETTE.darkMetal} />
      </mesh>
      {/* 凸面镜片（压扁的球面，浅钢蓝反光） */}
      <mesh position={[0, 2.42, 0.025]} scale={[0.235, 0.235, 0.09]}>
        <sphereGeometry args={[1, 18, 12]} />
        <meshStandardMaterial
          color="#c6d6e4"
          metalness={0.62}
          roughness={0.08}
          emissive="#a8bed6"
          emissiveIntensity={0.5}
        />
      </mesh>
      {/* 白色内圈 */}
      <mesh position={[0, 2.42, 0.05]}>
        <torusGeometry args={[0.245, 0.012, 6, 24]} />
        <Toon color={PALETTE.white} />
      </mesh>
      {/* 橙色外框 */}
      <mesh position={[0, 2.42, 0.04]}>
        <torusGeometry args={[0.272, 0.026, 8, 24]} />
        <Toon color={PALETTE.brandAlt} />
      </mesh>
      {/* 镜框与立杆的连接件 */}
      <ToonBox
        size={[0.07, 0.26, 0.07]}
        position={[0, 2.16, 0.02]}
        color={PALETTE.brandAlt}
        outline={0.006}
      />
    </group>
  );
}

/* -------------------------------------------------------- 行人过街标志 */

export function CrossingSign() {
  const sign = useMemo(() => createCrossingSignTexture(), []);
  const sub = useMemo(() => createCrossingSubTexture(), []);

  return (
    <group position={[1.78, 0, 2.58]}>
      <ToonCylinder
        radiusTop={0.035}
        radiusBottom={0.042}
        height={2.3}
        radialSegments={8}
        color={PALETTE.metal}
        position={[0, BASE_Y + 1.15, 0]}
        outline={0.01}
      />
      {/* 标志板背板 + 面板 */}
      <ToonBox
        size={[0.62, 0.62, 0.04]}
        position={[0, 2.0, 0.02]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <NeonPanel
        width={0.58}
        height={0.58}
        map={sign}
        position={[0, 2.0, 0.043]}
      />
      {/* 辅助文字牌「横断歩道」 */}
      <ToonBox
        size={[0.52, 0.18, 0.04]}
        position={[0, 1.56, 0.02]}
        color={PALETTE.cream}
        outline={0.008}
      />
      <NeonPanel
        width={0.46}
        height={0.12}
        map={sub}
        position={[0, 1.56, 0.043]}
      />
    </group>
  );
}

/* -------------------------------------------------------------- 护栏 */

/** 白色钢管护栏：立柱 + 上下两道横管 + 端头反光贴 */
export function PipeGuardrail({
  axis,
  fixed,
  from,
  to,
}: {
  /** 护栏延伸方向 */
  axis: "x" | "z";
  /** 垂直方向的固定坐标（axis=x 时为 z，axis=z 时为 x） */
  fixed: number;
  from: number;
  to: number;
}) {
  const length = Math.abs(to - from);
  const center = (from + to) / 2;
  const posts = useMemo(() => [from, center, to], [from, center, to]);
  const railRotation: Vec3 =
    axis === "x" ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0];

  const point = (along: number, y: number): Vec3 =>
    axis === "x" ? [along, y, fixed] : [fixed, y, along];

  return (
    <group>
      {posts.map((along, index) => (
        <ToonCylinder
          key={`post-${index}`}
          radiusTop={0.04}
          radiusBottom={0.045}
          height={0.88}
          radialSegments={8}
          color={PALETTE.white}
          position={point(along, BASE_Y + 0.44)}
          outline={0.008}
        />
      ))}
      <ToonCylinder
        radiusTop={0.036}
        radiusBottom={0.036}
        height={length}
        radialSegments={8}
        color={PALETTE.white}
        position={point(center, BASE_Y + 0.84)}
        rotation={railRotation}
        outline={0.008}
      />
      <ToonCylinder
        radiusTop={0.026}
        radiusBottom={0.026}
        height={length}
        radialSegments={8}
        color={PALETTE.white}
        position={point(center, BASE_Y + 0.5)}
        rotation={railRotation}
        outline={0.008}
      />
      {[from, to].map((along, index) => (
        <ToonCylinder
          key={`band-${index}`}
          radiusTop={0.048}
          radiusBottom={0.048}
          height={0.1}
          radialSegments={8}
          color={PALETTE.cream}
          position={point(along, BASE_Y + 0.64)}
          outline={0}
        />
      ))}
    </group>
  );
}

/* ---------------------------------------------------------- 后巷低墙 */

export function RearBoundary() {
  const wallColor = mixHex(PALETTE.sidewalk, PALETTE.concrete, 0.35);
  const capColor = mixHex(PALETTE.concrete, PALETTE.white, 0.18);
  const wallZ = -5.24;
  const wallHeight = 0.92;
  const pilasters = useMemo(() => [-3.54, 0.6, 2.6, 5.9], []);

  return (
    <group>
      {/* 低矮混凝土围墙 */}
      <ToonBox
        size={[9.6, wallHeight, 0.14]}
        position={[1.2, BASE_Y + wallHeight / 2, wallZ]}
        color={wallColor}
        outline={0.01}
      />
      {/* 压顶（宽度收到 9.6，确保不超出底座 x=±6） */}
      <ToonBox
        size={[9.6, 0.06, 0.2]}
        position={[1.2, BASE_Y + wallHeight + 0.03, wallZ]}
        color={capColor}
        outline={0}
      />
      {/* 壁柱 */}
      {pilasters.map((x) => (
        <ToonBox
          key={`pilaster-${x}`}
          size={[0.1, wallHeight + 0.06, 0.2]}
          position={[x, BASE_Y + (wallHeight + 0.06) / 2, wallZ]}
          color={mixHex(wallColor, PALETTE.darkMetal, 0.25)}
          outline={0.006}
        />
      ))}
      {/* 检修门（开向北侧背面） */}
      <ToonBox
        size={[1, 0.84, 0.06]}
        position={[4.0, BASE_Y + 0.42, wallZ - 0.1]}
        color={PALETTE.darkMetal}
        outline={0.008}
      />
      <ToonBox
        size={[0.05, 0.06, 0.05]}
        position={[4.4, BASE_Y + 0.46, wallZ - 0.14]}
        color={PALETTE.metal}
        outline={0}
      />
      <ToonBox
        size={[0.52, 0.16, 0.03]}
        position={[4.0, BASE_Y + 0.78, wallZ - 0.135]}
        color={PALETTE.cream}
        outline={0}
      />
    </group>
  );
}
