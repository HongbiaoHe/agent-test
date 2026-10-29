"use client";

import { useMemo } from "react";

import {
  Toon,
  ToonBox,
  ToonCylinder,
} from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";
import { createPosterTexture, mixHex } from "../core/textures";
import { createBinLabelTexture, type BinKind } from "./textures";

/**
 * 门口小件：资源回收桶 ×3 / 伞架 / A 字告示牌。
 * 全部以“脚底中心 = 原点”建模，摆放坐标由 props/index.tsx 统一给。
 */

type BinLook = { body: string; lid: string; accent: string };

const BIN_LOOKS: Record<BinKind, BinLook> = {
  can: {
    body: mixHex(PALETTE.glassDark, PALETTE.neonCyan, 0.3),
    lid: mixHex(PALETTE.glassDark, PALETTE.darkMetal, 0.35),
    accent: mixHex(PALETTE.glassDark, PALETTE.neonCyan, 0.62),
  },
  bottle: {
    body: mixHex(PALETTE.leaf, PALETTE.leafLight, 0.32),
    lid: mixHex(PALETTE.leafDark, PALETTE.darkMetal, 0.3),
    accent: mixHex(PALETTE.leaf, PALETTE.leafLight, 0.6),
  },
  pet: {
    body: PALETTE.metal,
    lid: PALETTE.darkMetal,
    accent: mixHex(PALETTE.metal, PALETTE.white, 0.36),
  },
};

/** 0.34 宽 × 0.62 高的回收桶，正面（+z）贴日文标签 */
export function RecycleBin({ kind, position }: { kind: BinKind; position: Vec3 }) {
  const look = BIN_LOOKS[kind];
  const labelTexture = useMemo(
    () => createBinLabelTexture(kind, look.accent),
    [kind, look.accent],
  );

  return (
    <group position={position}>
      {/* 底座 */}
      <ToonBox
        size={[0.31, 0.024, 0.27]}
        position={[0, 0.012, 0]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      {/* 桶身（略上宽下窄） */}
      <ToonBox
        size={[0.34, 0.55, 0.3]}
        position={[0, 0.299, 0]}
        color={look.body}
        outline={0.014}
      />
      {/* 顶部盖 */}
      <ToonBox
        size={[0.36, 0.055, 0.32]}
        position={[0, 0.601, 0]}
        color={look.lid}
        outline={0.012}
      />
      {/* 投入口 + 翻盖 */}
      <ToonBox
        size={[0.21, 0.03, 0.13]}
        position={[0, 0.628, 0.02]}
        color={PALETTE.darkMetal}
        outline={0.006}
      />
      <ToonBox
        size={[0.23, 0.018, 0.15]}
        position={[0, 0.643, 0.02]}
        rotation={[-0.38, 0, 0]}
        color={look.body}
        outline={0}
      />
      {/* 正面标签 */}
      <mesh position={[0, 0.4, 0.151]}>
        <planeGeometry args={[0.235, 0.176]} />
        <Toon
          color="#ffffff"
          map={labelTexture}
          emissive={PALETTE.cream}
          emissiveIntensity={0.18}
        />
      </mesh>
      {/* 两条竖向加强筋 */}
      {[-0.135, 0.135].map((x) => (
        <ToonBox
          key={x}
          size={[0.022, 0.46, 0.012]}
          position={[x, 0.31, 0.152]}
          color={look.lid}
          outline={0}
        />
      ))}
    </group>
  );
}

type UmbrellaSpec = {
  x: number;
  z: number;
  leanX: number;
  leanZ: number;
  ry: number;
  canopy: string;
  clear?: boolean;
  handle: string;
};

const UMBRELLAS: UmbrellaSpec[] = [
  {
    x: -0.13,
    z: 0.015,
    leanX: 0.05,
    leanZ: 0.12,
    ry: 0.3,
    canopy: PALETTE.glass,
    clear: true,
    handle: PALETTE.woodLight,
  },
  {
    x: 0.015,
    z: -0.025,
    leanX: -0.04,
    leanZ: -0.02,
    ry: -0.4,
    canopy: "#283748",
    handle: PALETTE.darkMetal,
  },
  {
    x: 0.14,
    z: 0.03,
    leanX: 0.03,
    leanZ: -0.1,
    ry: 1.1,
    canopy: mixHex(PALETTE.brandAlt, PALETTE.wood, 0.35),
    handle: PALETTE.wood,
  },
];

/** 一把收拢的伞：锥形伞面 + 伞杆 + J 形伞柄 + 伞尖 */
function Umbrella({ spec }: { spec: UmbrellaSpec }) {
  return (
    <group
      position={[spec.x, 0.02, spec.z]}
      rotation={[spec.leanX, spec.ry, spec.leanZ]}
    >
      {/* 伞尖 */}
      <ToonCylinder
        radiusTop={0.009}
        radiusBottom={0.003}
        height={0.09}
        position={[0, 0.085, 0]}
        color={spec.clear ? PALETTE.glass : PALETTE.darkMetal}
        outline={0.004}
      />
      {/* 收拢的伞面：上宽下窄的锥筒 */}
      <mesh position={[0, 0.39, 0]}>
        <cylinderGeometry args={[0.085, 0.016, 0.58, 8]} />
        {spec.clear ? (
          <Toon
            color={spec.canopy}
            opacity={0.5}
            transparent
            depthWrite={false}
          />
        ) : (
          <Toon color={spec.canopy} />
        )}
      </mesh>
      {/* 伞面束带 */}
      <ToonCylinder
        radiusTop={0.087}
        radiusBottom={0.087}
        height={0.032}
        radialSegments={8}
        position={[0, 0.665, 0]}
        color={spec.clear ? PALETTE.white : mixHex(spec.canopy, "#ffffff", 0.5)}
        outline={0}
      />
      {/* 伞杆 */}
      <ToonCylinder
        radiusTop={0.011}
        radiusBottom={0.011}
        height={0.42}
        radialSegments={6}
        position={[0, 0.89, 0]}
        color={PALETTE.metal}
        outline={0}
      />
      {/* J 形伞柄 */}
      <mesh position={[0, 1.105, 0]} rotation={[0, 0, Math.PI]}>
        <torusGeometry args={[0.05, 0.015, 6, 10, Math.PI]} />
        <Toon color={spec.handle} />
      </mesh>
    </group>
  );
}

/** 门口金属伞架 + 三把伞 */
export function UmbrellaStand({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      {/* 底盘 */}
      <ToonBox
        size={[0.5, 0.03, 0.28]}
        position={[0, 0.015, 0]}
        color={PALETTE.metal}
        outline={0.01}
      />
      <ToonBox
        size={[0.46, 0.012, 0.24]}
        position={[0, 0.036, 0]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      {/* 四角立柱（矮一点，让收拢的伞面探出架口） */}
      {[
        [-0.22, -0.11],
        [-0.22, 0.11],
        [0.22, -0.11],
        [0.22, 0.11],
      ].map(([x, z]) => (
        <ToonBox
          key={`${x}-${z}`}
          size={[0.018, 0.44, 0.018]}
          position={[x, 0.25, z]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}
      {/* 上下两圈横杆 */}
      {[0.47, 0.29].map((y) => (
        <group key={y}>
          <ToonBox size={[0.46, 0.016, 0.016]} position={[0, y, 0.11]} color={PALETTE.metal} outline={0} />
          <ToonBox size={[0.46, 0.016, 0.016]} position={[0, y, -0.11]} color={PALETTE.metal} outline={0} />
          <ToonBox size={[0.016, 0.016, 0.22]} position={[-0.22, y, 0]} color={PALETTE.metal} outline={0} />
          <ToonBox size={[0.016, 0.016, 0.22]} position={[0.22, y, 0]} color={PALETTE.metal} outline={0} />
        </group>
      ))}
      {/* 底部沥水格栅 */}
      {[-0.07, 0, 0.07].map((z) => (
        <ToonBox key={z} size={[0.4, 0.008, 0.012]} position={[0, 0.044, z]} color={PALETTE.metal} outline={0} />
      ))}
      {UMBRELLAS.map((spec) => (
        <Umbrella key={`${spec.x}-${spec.z}`} spec={spec} />
      ))}
    </group>
  );
}

/** A 字木框告示牌：两片板 + 顶部铰链 + 双面海报 */
export function AFrameBoard({ position, rotationY }: { position: Vec3; rotationY: number }) {
  const poster = useMemo(
    () =>
      createPosterTexture({
        title: "本日のおすすめ",
        subtitle: "おにぎり全品 20% OFF",
        bg: "#f4ecd9",
        accent: PALETTE.brandAlt,
        badge: "SALE",
      }),
    [],
  );

  const panel = (front: boolean) => (
    <group
      position={[0, 0.43, front ? 0.07 : -0.07]}
      rotation={[0, front ? 0 : Math.PI, 0]}
    >
      <group rotation={[-0.163, 0, 0]}>
        {/* 木框 */}
        <ToonBox size={[0.48, 0.04, 0.035]} position={[0, 0.42, 0]} color={PALETTE.wood} outline={0.008} />
        <ToonBox size={[0.48, 0.04, 0.035]} position={[0, -0.42, 0]} color={PALETTE.wood} outline={0.008} />
        <ToonBox size={[0.045, 0.88, 0.035]} position={[-0.22, 0, 0]} color={PALETTE.wood} outline={0.008} />
        <ToonBox size={[0.045, 0.88, 0.035]} position={[0.22, 0, 0]} color={PALETTE.wood} outline={0.008} />
        {/* 白色板面 */}
        <ToonBox size={[0.4, 0.8, 0.012]} position={[0, 0, 0]} color={PALETTE.cream} outline={0} />
        {/* 海报 */}
        <mesh position={[0, 0.02, 0.009]}>
          <planeGeometry args={[0.36, 0.5]} />
          <Toon color="#ffffff" map={poster} emissive={PALETTE.cream} emissiveIntensity={0.12} />
        </mesh>
      </group>
    </group>
  );

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {panel(true)}
      {panel(false)}
      {/* 顶部铰链 */}
      <ToonCylinder
        radiusTop={0.018}
        radiusBottom={0.018}
        height={0.5}
        radialSegments={8}
        position={[0, 0.868, 0]}
        rotation={[0, 0, Math.PI / 2]}
        color={PALETTE.metal}
        outline={0.006}
      />
      {/* 脚垫 */}
      {[
        [-0.22, 0.145],
        [0.22, 0.145],
        [-0.22, -0.145],
        [0.22, -0.145],
      ].map(([x, z]) => (
        <ToonBox
          key={`${x}-${z}`}
          size={[0.05, 0.025, 0.05]}
          position={[x, 0.012, z]}
          color={PALETTE.darkMetal}
          outline={0}
        />
      ))}
    </group>
  );
}
