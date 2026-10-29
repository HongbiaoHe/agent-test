"use client";

import { useMemo } from "react";

import { Glow, Toon, ToonBox, ToonCylinder } from "../core/materials";
import { PALETTE, SIDEWALK, type Vec3 } from "../core/scene-config";
import { mixHex } from "../core/textures";

import { createNorenTexture } from "./textures";

/**
 * 东侧小巷入口：两根木柱 + 横梁 + 藏青暖帘（ひかり）+ 纸灯笼 +
 * 更深的巷内地面与排水明沟，外加东侧低围墙把巷子收住。
 *
 * 巷内纸灯笼的位置贴合 core/lights.tsx 的小巷 pointLight (4.5, 2.05, -1.25)，
 * 巷口再挂一只暖灯；两只都包在 <Power> 里一起点亮。
 */

const MOUTH_Z = 0.66;
const FLOOR_X0 = 4.22;
const FLOOR_X1 = 5.95;
const BASE_Y = 0.18;
const FLOOR_TOP = SIDEWALK.topY;

const FLOOR_COLOR = mixHex(PALETTE.asphaltDark, PALETTE.gutter, 0.45);

type PaperLanternProps = {
  position: Vec3;
  color: string;
  emissive: string;
};

/** 纸灯笼（自发光球体 + 上下金属盖） */
function PaperLantern({ position, color, emissive }: PaperLanternProps) {
  return (
    <group position={position}>
      <mesh scale={[1, 1.18, 1]}>
        <sphereGeometry args={[0.15, 14, 10]} />
        <Toon color={color} emissive={emissive} emissiveIntensity={1.6} />
      </mesh>
      <ToonCylinder
        radiusTop={0.055}
        radiusBottom={0.055}
        height={0.032}
        radialSegments={10}
        color={PALETTE.darkMetal}
        position={[0, 0.178, 0]}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.055}
        radiusBottom={0.055}
        height={0.032}
        radialSegments={10}
        color={PALETTE.darkMetal}
        position={[0, -0.178, 0]}
        outline={0}
      />
    </group>
  );
}

export function AlleyEntrance() {
  const noren = useMemo(
    () => [
      createNorenTexture("ひ"),
      createNorenTexture("か"),
      createNorenTexture("り"),
    ],
    [],
  );

  const panels = useMemo(
    () => [
      { x: 4.64, map: noren[0] },
      { x: 5.1, map: noren[1] },
      { x: 5.56, map: noren[2] },
    ],
    [noren],
  );

  const wallColor = mixHex(
    mixHex(PALETTE.sidewalk, PALETTE.concrete, 0.4),
    PALETTE.wood,
    0.18,
  );

  return (
    <group>
      {/* 巷内地面（比人行道砖更深；前场段抬到湿面层之上） */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(FLOOR_X0 + FLOOR_X1) / 2, FLOOR_TOP + 0.0035, -2.73]}
        receiveShadow
      >
        <planeGeometry args={[FLOOR_X1 - FLOOR_X0, 4.24]} />
        <Toon color={FLOOR_COLOR} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(FLOOR_X0 + FLOOR_X1) / 2, FLOOR_TOP + 0.0095, 0.055]}
        receiveShadow
      >
        <planeGeometry args={[FLOOR_X1 - FLOOR_X0, 1.33]} />
        <Toon color={FLOOR_COLOR} />
      </mesh>

      {/* 排水明沟 */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[5, FLOOR_TOP + 0.005, -2.73]}
        receiveShadow
      >
        <planeGeometry args={[0.16, 4.2]} />
        <Toon color={PALETTE.gutter} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[5, FLOOR_TOP + 0.011, 0.055]}
        receiveShadow
      >
        <planeGeometry args={[0.16, 1.3]} />
        <Toon color={PALETTE.gutter} />
      </mesh>

      {/* 地面高差的金属收边 */}
      <ToonBox
        size={[FLOOR_X1 - FLOOR_X0, 0.014, 0.09]}
        position={[(FLOOR_X0 + FLOOR_X1) / 2, FLOOR_TOP + 0.017, -0.61]}
        color={PALETTE.metal}
        outline={0}
      />

      {/* 巷口两根木柱 */}
      <ToonCylinder
        radiusTop={0.062}
        radiusBottom={0.075}
        height={2.62}
        radialSegments={10}
        color={PALETTE.wood}
        position={[4.34, BASE_Y + 1.31, MOUTH_Z]}
        outline={0.012}
      />
      <ToonCylinder
        radiusTop={0.062}
        radiusBottom={0.075}
        height={2.62}
        radialSegments={10}
        color={PALETTE.wood}
        position={[5.86, BASE_Y + 1.31, MOUTH_Z]}
        outline={0.012}
      />
      {/* 横梁 */}
      <ToonBox
        size={[1.66, 0.09, 0.1]}
        position={[5.1, 2.52, MOUTH_Z]}
        color={PALETTE.woodLight}
        outline={0.008}
      />

      {/* 藏青暖帘（ひかり） */}
      {panels.map((panel) => (
        <mesh
          key={panel.x}
          position={[panel.x, 2.01, MOUTH_Z + 0.005]}
          receiveShadow
        >
          <planeGeometry args={[0.44, 0.92]} />
          <Toon color="#ffffff" map={panel.map} />
        </mesh>
      ))}

      {/* 巷口纸灯笼（从横梁伸出的短臂 + 吊绳） */}
      <ToonBox
        size={[0.04, 0.04, 0.3]}
        position={[5.0, 2.5, MOUTH_Z + 0.13]}
        color={PALETTE.woodLight}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.008}
        radiusBottom={0.008}
        height={0.19}
        radialSegments={6}
        color={PALETTE.darkMetal}
        position={[5.0, 2.385, 0.92]}
        outline={0}
      />
      <PaperLantern
        position={[5.0, 2.12, 0.92]}
        color={PALETTE.warmLight}
        emissive={PALETTE.lampWarm}
      />
      <Glow
        color={PALETTE.lampWarm}
        size={1.6}
        opacity={0.55}
        position={[5.0, 2.1, 0.98]}
      />

      {/* 巷内深处的纸灯笼（对齐 core 的小巷灯光 4.5,2.05,-1.25） */}
      <ToonBox
        size={[0.34, 0.05, 0.05]}
        position={[4.37, 2.4, -1.25]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.008}
        radiusBottom={0.008}
        height={0.24}
        radialSegments={6}
        color={PALETTE.darkMetal}
        position={[4.5, 2.28, -1.25]}
        outline={0}
      />
      <PaperLantern
        position={[4.5, 2.05, -1.25]}
        color="#f7d9e2"
        emissive={PALETTE.neonPink}
      />
      <Glow
        color={PALETTE.neonPink}
        size={1.2}
        opacity={0.38}
        position={[4.56, 2.05, -1.25]}
      />

      {/* 东侧低围墙（把巷子收住，挡住底座东边缘） */}
      <ToonBox
        size={[0.14, 0.72, 5.5]}
        position={[5.92, BASE_Y + 0.36, -2.2]}
        color={wallColor}
        outline={0.01}
      />
      <ToonBox
        size={[0.2, 0.05, 5.5]}
        position={[5.9, BASE_Y + 0.745, -2.2]}
        color={mixHex(PALETTE.concrete, PALETTE.white, 0.18)}
        outline={0}
      />
      <ToonBox
        size={[0.18, 0.8, 0.18]}
        position={[5.91, BASE_Y + 0.4, -4.5]}
        color={mixHex(wallColor, PALETTE.darkMetal, 0.2)}
        outline={0.006}
      />
      <ToonBox
        size={[0.18, 0.8, 0.18]}
        position={[5.91, BASE_Y + 0.4, 0.2]}
        color={mixHex(wallColor, PALETTE.darkMetal, 0.2)}
        outline={0.006}
      />
    </group>
  );
}
