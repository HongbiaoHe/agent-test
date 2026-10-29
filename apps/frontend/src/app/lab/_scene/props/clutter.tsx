"use client";

import { Outlines } from "@react-three/drei";

import {
  OUTLINE_COLOR,
  Toon,
  ToonBox,
  ToonCylinder,
} from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";
import { mixHex } from "../core/textures";
import { ContactShadow } from "./shadow";

/**
 * 巷口杂物：啤酒箱堆、纸箱、盆栽 ×2、停车位旁的橙色锥桶。
 * 全部以脚底中心为原点；不追求细节，只保证剪影能一层层读出来。
 */

const CRATE_AMBER = mixHex(PALETTE.brandAlt, PALETTE.wood, 0.46);
const CRATE_RED = mixHex(PALETTE.neonPink, PALETTE.wood, 0.52);
const CARTON = mixHex(PALETTE.cream, PALETTE.wood, 0.3);
const CARTON_LIGHT = mixHex(PALETTE.cream, PALETTE.wood, 0.16);
const POT_DARK = mixHex(PALETTE.wood, PALETTE.darkMetal, 0.55);
const POT_RIM = mixHex(PALETTE.woodLight, PALETTE.darkMetal, 0.35);

const BOTTLE_SPECS: { x: number; z: number; color: string }[] = [
  { x: -0.1, z: 0.04, color: PALETTE.woodLight },
  { x: 0.01, z: -0.04, color: PALETTE.leaf },
  { x: 0.11, z: 0.03, color: PALETTE.woodLight },
];

/** 单只啤酒箱（带瓶口 / 侧板条） */
function BeerCrate({
  color,
  bottles = false,
}: {
  color: string;
  bottles?: boolean;
}) {
  const dark = mixHex(color, "#000000", 0.3);
  const light = mixHex(color, "#ffffff", 0.14);
  return (
    <group>
      <ToonBox size={[0.38, 0.22, 0.3]} position={[0, 0.11, 0]} color={color} outline={0.012} />
      {/* 顶部箱沿 */}
      <ToonBox size={[0.4, 0.028, 0.32]} position={[0, 0.228, 0]} color={dark} outline={0} />
      {/* 正面/侧面横板条，制造板箱的层次 */}
      {[0.155, 0.065].map((y) => (
        <group key={y}>
          <ToonBox size={[0.33, 0.045, 0.014]} position={[0, y, 0.152]} color={light} outline={0} />
          <ToonBox size={[0.33, 0.045, 0.014]} position={[0, y, -0.152]} color={light} outline={0} />
          <ToonBox size={[0.014, 0.045, 0.27]} position={[0.192, y, 0]} color={light} outline={0} />
          <ToonBox size={[0.014, 0.045, 0.27]} position={[-0.192, y, 0]} color={light} outline={0} />
        </group>
      ))}
      {/* 正面小标签 */}
      <ToonBox size={[0.13, 0.07, 0.008]} position={[0, 0.15, 0.158]} color={PALETTE.cream} outline={0} />
      {/* 瓶口从箱子里探出来 */}
      {bottles
        ? BOTTLE_SPECS.map((bottle) => (
            <group key={`${bottle.x}-${bottle.z}`} position={[bottle.x, 0.24, bottle.z]}>
              <ToonCylinder
                radiusTop={0.018}
                radiusBottom={0.021}
                height={0.13}
                radialSegments={6}
                position={[0, 0.065, 0]}
                color={bottle.color}
                outline={0.004}
              />
              <ToonCylinder
                radiusTop={0.011}
                radiusBottom={0.011}
                height={0.028}
                radialSegments={6}
                position={[0, 0.14, 0]}
                color={PALETTE.curb}
                outline={0}
              />
            </group>
          ))
        : null}
    </group>
  );
}

/** 两只叠起来的啤酒箱 */
export function BeerCrateStack({
  position,
  rotationY,
}: {
  position: Vec3;
  rotationY: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ContactShadow size={0.74} position={[0.02, 0.0025, 0.02]} opacity={0.5} />
      <BeerCrate color={CRATE_AMBER} />
      <group position={[0.01, 0.245, 0]} rotation={[0, 0.16, 0]}>
        <BeerCrate color={CRATE_RED} bottles />
      </group>
    </group>
  );
}

/** 纸箱：顶盖半开 + 胶带 + 侧贴纸 */
export function CardboardBox({
  position,
  rotationY,
}: {
  position: Vec3;
  rotationY: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ToonBox size={[0.34, 0.26, 0.3]} position={[0, 0.13, 0]} color={CARTON} outline={0.01} />
      {/* 顶盖两片微翘 */}
      <ToonBox
        size={[0.32, 0.012, 0.13]}
        position={[0, 0.264, 0.077]}
        rotation={[0.16, 0, 0]}
        color={CARTON_LIGHT}
        outline={0}
      />
      <ToonBox
        size={[0.32, 0.012, 0.13]}
        position={[0, 0.264, -0.077]}
        rotation={[-0.16, 0, 0]}
        color={CARTON_LIGHT}
        outline={0}
      />
      {/* 胶带 */}
      <ToonBox size={[0.06, 0.004, 0.31]} position={[0, 0.271, 0]} color={mixHex(PALETTE.cream, PALETTE.white, 0.4)} outline={0} />
      {/* 侧贴纸 / 封条 */}
      <ToonBox size={[0.12, 0.08, 0.008]} position={[-0.05, 0.15, 0.152]} color={PALETTE.cream} outline={0} />
      <ToonBox size={[0.055, 0.055, 0.01]} position={[0.09, 0.14, 0.152]} color={mixHex(PALETTE.brandAlt, PALETTE.wood, 0.25)} outline={0} />
      {/* 侧面提手孔 */}
      <ToonBox size={[0.008, 0.05, 0.1]} position={[0.172, 0.16, 0]} color={PALETTE.darkMetal} outline={0} />
    </group>
  );
}

const LEAF_ANGLES = [0, 0.785, 1.571, 2.356, 3.142, 3.927, 4.712, 5.498];

/** 深色陶盆 + 低模叶子（两种变体错开叶形） */
export function PottedPlant({
  position,
  variant,
}: {
  position: Vec3;
  variant: "a" | "b";
}) {
  const tilt = variant === "a" ? 0.62 : 0.48;
  const baseHeight = variant === "a" ? 0.26 : 0.22;
  return (
    <group position={position}>
      <ContactShadow size={0.44} position={[0, 0.0025, 0]} opacity={0.45} />
      {/* 盆 */}
      <ToonCylinder
        radiusTop={0.115}
        radiusBottom={0.082}
        height={0.2}
        radialSegments={10}
        position={[0, 0.1, 0]}
        color={POT_DARK}
        outline={0.01}
      />
      <ToonCylinder
        radiusTop={0.122}
        radiusBottom={0.122}
        height={0.042}
        radialSegments={10}
        position={[0, 0.2, 0]}
        color={POT_RIM}
        outline={0.008}
      />
      {/* 土 */}
      <ToonCylinder
        radiusTop={0.104}
        radiusBottom={0.104}
        height={0.012}
        radialSegments={10}
        position={[0, 0.222, 0]}
        color={PALETTE.asphaltDark}
        outline={0}
      />
      {/* 叶子：向外张开的四棱锥 */}
      {LEAF_ANGLES.map((angle, index) => {
        const height = baseHeight + (index % 3) * 0.035;
        const leafColor =
          index % 3 === 0
            ? PALETTE.leaf
            : index % 3 === 1
              ? PALETTE.leafLight
              : PALETTE.leafDark;
        return (
          <group
            key={angle}
            position={[Math.cos(angle) * 0.045, 0.225, Math.sin(angle) * 0.045]}
            rotation={[Math.sin(angle) * tilt, angle * 0.3, -Math.cos(angle) * tilt]}
          >
            <mesh position={[0, height / 2, 0]} castShadow>
              <coneGeometry args={[0.052, height, 4]} />
              <Toon color={leafColor} />
              <Outlines thickness={0.006} color={OUTLINE_COLOR} />
            </mesh>
          </group>
        );
      })}
      {/* 中间两片立叶，撑起高度 */}
      <mesh position={[0, 0.225 + baseHeight * 0.62, 0]} castShadow>
        <coneGeometry args={[0.05, baseHeight * 1.24, 4]} />
        <Toon color={PALETTE.leafLight} />
        <Outlines thickness={0.006} color={OUTLINE_COLOR} />
      </mesh>
    </group>
  );
}

/** 橙色交通锥（停车位旁） */
export function TrafficCone({
  position,
  rotationY,
}: {
  position: Vec3;
  rotationY: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ContactShadow size={0.42} position={[0, 0.0025, 0]} opacity={0.4} />
      <ToonBox
        size={[0.3, 0.032, 0.3]}
        position={[0, 0.016, 0]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <mesh position={[0, 0.03 + 0.21, 0]} castShadow>
        <coneGeometry args={[0.145, 0.42, 12]} />
        <Toon color={PALETTE.brandAlt} />
        <Outlines thickness={0.012} color={OUTLINE_COLOR} />
      </mesh>
      {/* 白色反光带 */}
      <ToonCylinder
        radiusTop={0.05}
        radiusBottom={0.073}
        height={0.075}
        radialSegments={12}
        position={[0, 0.29, 0]}
        color={PALETTE.white}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.02}
        radiusBottom={0.024}
        height={0.05}
        radialSegments={10}
        position={[0, 0.465, 0]}
        color={mixHex(PALETTE.brandAlt, PALETTE.wood, 0.2)}
        outline={0}
      />
    </group>
  );
}
