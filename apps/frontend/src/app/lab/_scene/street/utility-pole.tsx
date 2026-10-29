"use client";

import { Line } from "@react-three/drei";
import { useMemo } from "react";

import { NeonPanel, Toon, ToonBox, ToonCylinder } from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";

import {
  createPoleNumberTexture,
  createStreetNameTexture,
} from "./textures";

/**
 * 混凝土电线杆：横担、变压器、绝缘子、脚钉、町名牌 + 5 条下垂电线。
 * 电线用 drei <Line>（屏幕像素宽），末端落在底座边缘，制造「模型被裁切」的感觉。
 */

const POLE_X = -3.16;
const POLE_Z = -0.86;
const BASE_Y = 0.18;
const POLE_HEIGHT = 5.4;

/** 明显的悬链下垂：两端之间二次插值 + sag */
function sagLine(from: Vec3, to: Vec3, sag: number, segments = 18): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = from[0] + (to[0] - from[0]) * t;
    const z = from[2] + (to[2] - from[2]) * t;
    const y = from[1] + (to[1] - from[1]) * t - sag * 4 * t * (1 - t);
    points.push([x, y, z]);
  }
  return points;
}

export function UtilityPole() {
  const streetName = useMemo(() => createStreetNameTexture(), []);
  const poleNumber = useMemo(() => createPoleNumberTexture(), []);

  const crossarmA = 4.95;
  const crossarmB = 5.28;
  const insulatorTopA = crossarmA + 0.11 + 0.06;
  const insulatorTopB = crossarmB + 0.1 + 0.06;

  const wires = useMemo(
    () => [
      // 向西跨出底座边缘
      sagLine([POLE_X - 0.7, insulatorTopA, POLE_Z], [-5.98, 4.55, POLE_Z - 0.42], 0.55),
      sagLine([POLE_X - 0.25, insulatorTopA, POLE_Z], [-5.98, 4.4, POLE_Z + 0.6], 0.5),
      // 向东跨过店屋顶，落到东侧边缘
      sagLine([POLE_X + 0.25, insulatorTopA, POLE_Z], [5.98, 4.75, POLE_Z - 0.34], 0.8),
      sagLine([POLE_X + 0.5, insulatorTopB, POLE_Z], [5.98, 4.98, POLE_Z + 0.56], 0.85),
      // 引下线：垂到便利店屋顶的进线杆
      sagLine([POLE_X + 0.7, insulatorTopA, POLE_Z], [0.75, 3.55, -0.62], 0.35),
    ],
    [insulatorTopA, insulatorTopB],
  );

  const insulatorsA = useMemo(() => [-0.7, -0.25, 0.25, 0.7], []);
  const insulatorsB = useMemo(() => [-0.5, 0.5], []);
  const pegs = useMemo(
    () => [
      { y: 1.2, side: -1 },
      { y: 1.8, side: 1 },
      { y: 2.4, side: -1 },
      { y: 3.0, side: 1 },
      { y: 3.6, side: -1 },
    ],
    [],
  );

  return (
    <group>
      {/* 杆身 */}
      <ToonCylinder
        radiusTop={0.105}
        radiusBottom={0.15}
        height={POLE_HEIGHT}
        radialSegments={14}
        color={PALETTE.concrete}
        position={[POLE_X, BASE_Y + POLE_HEIGHT / 2, POLE_Z]}
        outline={0.012}
      />

      {/* 两根横担 */}
      <ToonBox
        size={[1.7, 0.09, 0.1]}
        position={[POLE_X, crossarmA, POLE_Z]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <ToonBox
        size={[1.35, 0.08, 0.1]}
        position={[POLE_X, crossarmB, POLE_Z]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />

      {/* 绝缘子 */}
      {insulatorsA.map((offset) => (
        <ToonCylinder
          key={`insulator-a-${offset}`}
          radiusTop={0.035}
          radiusBottom={0.045}
          height={0.11}
          radialSegments={8}
          color={PALETTE.cream}
          position={[POLE_X + offset, crossarmA + 0.11, POLE_Z]}
          outline={0.006}
        />
      ))}
      {insulatorsB.map((offset) => (
        <ToonCylinder
          key={`insulator-b-${offset}`}
          radiusTop={0.04}
          radiusBottom={0.05}
          height={0.1}
          radialSegments={8}
          color={PALETTE.cream}
          position={[POLE_X + offset, crossarmB + 0.1, POLE_Z]}
          outline={0.006}
        />
      ))}

      {/* 变压器 x2 */}
      <ToonCylinder
        radiusTop={0.18}
        radiusBottom={0.18}
        height={0.5}
        radialSegments={12}
        color={PALETTE.metal}
        position={[POLE_X - 0.36, 4.2, POLE_Z]}
        outline={0.012}
      />
      <ToonCylinder
        radiusTop={0.18}
        radiusBottom={0.18}
        height={0.5}
        radialSegments={12}
        color={PALETTE.metal}
        position={[POLE_X + 0.36, 4.2, POLE_Z]}
        outline={0.012}
      />
      <ToonBox
        size={[0.22, 0.05, 0.1]}
        position={[POLE_X - 0.24, 4.48, POLE_Z]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <ToonBox
        size={[0.22, 0.05, 0.1]}
        position={[POLE_X + 0.24, 4.48, POLE_Z]}
        color={PALETTE.darkMetal}
        outline={0}
      />

      {/* 脚钉（左右交错，避开猫的高度） */}
      {pegs.map((peg) => (
        <ToonBox
          key={`peg-${peg.y}`}
          size={[0.28, 0.032, 0.032]}
          position={[POLE_X + peg.side * 0.2, peg.y, POLE_Z]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}

      {/* 町名牌「桜町 2丁目 / Sakura-machi 2」+ 小号牌：
          绕杆旋向西南，默认机位下文字不会被杆身挡住 */}
      <group position={[POLE_X, 0, POLE_Z]} rotation={[0, -0.48, 0]}>
        <ToonBox
          size={[0.84, 0.36, 0.05]}
          position={[0, 2.06, 0.12]}
          color={PALETTE.cream}
          outline={0.008}
        />
        <NeonPanel
          width={0.78}
          height={0.3}
          map={streetName}
          position={[0, 2.06, 0.147]}
        />
        <ToonBox
          size={[0.3, 0.24, 0.05]}
          position={[0, 2.62, 0.12]}
          color={PALETTE.white}
          outline={0.006}
        />
        <NeonPanel
          width={0.26}
          height={0.2}
          map={poleNumber}
          position={[0, 2.62, 0.147]}
        />
      </group>

      {/* 屋顶进线杆（引下线终点） */}
      <ToonBox
        size={[0.055, 0.24, 0.055]}
        position={[0.75, 3.46, -0.62]}
        color={PALETTE.darkMetal}
        outline={0}
      />

      {/* 下垂电线 */}
      {wires.map((points, index) => (
        <Line
          key={`wire-${index}`}
          points={points}
          color="#2a3348"
          lineWidth={1.4}
        />
      ))}

      {/* 电杆上的小接线夹（细节，非必须但让杆顶不空） */}
      <ToonBox
        size={[0.16, 0.1, 0.1]}
        position={[POLE_X, 4.9, POLE_Z]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <ToonBox
        size={[0.14, 0.2, 0.14]}
        position={[POLE_X, 3.66, POLE_Z - 0.02]}
        color={PALETTE.darkMetal}
        outline={0.006}
      />
      <mesh position={[POLE_X, 3.66, POLE_Z + 0.06]} rotation={[0, 0, 0]}>
        <planeGeometry args={[0.1, 0.14]} />
        <Toon color={PALETTE.metal} />
      </mesh>
    </group>
  );
}
