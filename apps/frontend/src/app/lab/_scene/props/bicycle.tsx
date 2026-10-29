"use client";

import { Outlines } from "@react-three/drei";
import * as THREE from "three";

import {
  OUTLINE_COLOR,
  Toon,
  ToonBox,
  ToonCylinder,
} from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";

/**
 * 街边城市自行车（斜停、脚撑撑住）。
 * 本地坐标：车头朝 +x，原点在前后轮接地线中点，y=0 为地面。
 *
 * 结构：两轮(torus + 8 根辐条 + 花鼓) / 菱形车架(圆柱管) / 前叉 / 车把 + 握把 +
 * 铃铛 + 刹车把 / 车座 + 座管 / 前车筐(钢丝框) / 后货架 / 挡泥板 / 链条 + 牙盘 +
 * 曲柄脚踏 / 脚撑。整体约 1.69 长 × 1.0 高。
 */

const TIRE = "#141823";
const RIM = PALETTE.concrete;
const FRAME = "#278872";
const FRAME_DARK = "#1d625c";
const METAL = PALETTE.curb;
const DARK = PALETTE.darkMetal;

const UP = new THREE.Vector3(0, 1, 0);

function tubeTransform(from: Vec3, to: Vec3): { position: Vec3; rotation: Vec3; length: number } {
  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const dir = b.clone().sub(a);
  const length = dir.length();
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    UP,
    dir.normalize(),
  );
  const euler = new THREE.Euler().setFromQuaternion(quaternion);
  return {
    position: [mid.x, mid.y, mid.z],
    rotation: [euler.x, euler.y, euler.z],
    length,
  };
}

/** 两点之间的一根圆管（车架 / 货架支撑 / 脚撑…） */
function Tube({
  from,
  to,
  radius,
  color,
  outline = 0.006,
}: {
  from: Vec3;
  to: Vec3;
  radius: number;
  color: string;
  outline?: number;
}) {
  const { position, rotation, length } = tubeTransform(from, to);
  return (
    <ToonCylinder
      radiusTop={radius}
      radiusBottom={radius}
      height={length}
      radialSegments={8}
      position={position}
      rotation={rotation}
      color={color}
      outline={outline}
    />
  );
}

const SPOKE_ANGLES = [0, 0.785, 1.571, 2.356, 3.142, 3.927, 4.712, 5.498];

function Wheel({ center }: { center: Vec3 }) {
  return (
    <group position={center}>
      {/* 外胎 */}
      <mesh castShadow>
        <torusGeometry args={[0.34, 0.024, 8, 30]} />
        <Toon color={TIRE} />
        <Outlines thickness={0.012} color={OUTLINE_COLOR} />
      </mesh>
      {/* 轮圈 */}
      <mesh>
        <torusGeometry args={[0.306, 0.009, 5, 28]} />
        <Toon color={RIM} />
      </mesh>
      {/* 辐条 */}
      {SPOKE_ANGLES.map((angle) => (
        <ToonCylinder
          key={angle}
          radiusTop={0.0038}
          radiusBottom={0.0038}
          height={0.3}
          radialSegments={5}
          position={[Math.sin(angle) * 0.15, Math.cos(angle) * 0.15, 0]}
          rotation={[0, 0, -angle]}
          color={RIM}
          outline={0}
        />
      ))}
      {/* 花鼓 */}
      <ToonCylinder
        radiusTop={0.022}
        radiusBottom={0.022}
        height={0.075}
        radialSegments={8}
        rotation={[Math.PI / 2, 0, 0]}
        color={METAL}
        outline={0.006}
      />
    </group>
  );
}

/** 挡泥板：半圈 partial torus，绕轮心上方 */
function Fender({
  center,
  startAngle,
  color,
}: {
  center: Vec3;
  startAngle: number;
  color: string;
}) {
  return (
    <mesh position={center} rotation={[0, 0, startAngle]} castShadow>
      <torusGeometry args={[0.378, 0.012, 5, 13, Math.PI * 0.82]} />
      <Toon color={color} />
    </mesh>
  );
}

/** 前车筐：低模钢丝框（底 + 上下两圈横杆 + 四角立柱） */
function FrontBasket() {
  const centerX = 0.66;
  const halfW = 0.145;
  const halfD = 0.13;
  const bottomY = 0.665;
  const topY = 0.86;
  const midY = 0.765;
  return (
    <group>
      <ToonBox
        size={[halfW * 2, 0.014, halfD * 2]}
        position={[centerX, bottomY, 0]}
        color={METAL}
        outline={0}
      />
      {[topY, midY].map((y) => (
        <group key={y}>
          <ToonBox
            size={[halfW * 2 + 0.012, 0.012, 0.012]}
            position={[centerX, y, halfD]}
            color={RIM}
            outline={0}
          />
          <ToonBox
            size={[halfW * 2 + 0.012, 0.012, 0.012]}
            position={[centerX, y, -halfD]}
            color={RIM}
            outline={0}
          />
          <ToonBox
            size={[0.012, 0.012, halfD * 2]}
            position={[centerX + halfW, y, 0]}
            color={RIM}
            outline={0}
          />
          <ToonBox
            size={[0.012, 0.012, halfD * 2]}
            position={[centerX - halfW, y, 0]}
            color={RIM}
            outline={0}
          />
        </group>
      ))}
      {[
        [centerX - halfW, -halfD],
        [centerX - halfW, halfD],
        [centerX + halfW, -halfD],
        [centerX + halfW, halfD],
      ].map(([x, z]) => (
        <ToonBox
          key={`${x}-${z}`}
          size={[0.012, topY - bottomY, 0.012]}
          position={[x, (topY + bottomY) / 2, z]}
          color={RIM}
          outline={0}
        />
      ))}
      {/* 车筐支架：连到车把立管 + 前叉轴 */}
      <Tube
        from={[centerX - halfW, bottomY, 0]}
        to={[0.31, 0.9, 0]}
        radius={0.008}
        color={METAL}
        outline={0}
      />
      <Tube
        from={[centerX + halfW, bottomY + 0.02, halfD]}
        to={[0.5, 0.38, 0.05]}
        radius={0.007}
        color={METAL}
        outline={0}
      />
      <Tube
        from={[centerX + halfW, bottomY + 0.02, -halfD]}
        to={[0.5, 0.38, -0.05]}
        radius={0.007}
        color={METAL}
        outline={0}
      />
    </group>
  );
}

export function Bicycle({ position, rotationY }: { position: Vec3; rotationY: number }) {
  // 关键点（本地坐标，y=0 地面）
  const rearHub: Vec3 = [-0.48, 0.364, 0];
  const frontHub: Vec3 = [0.48, 0.364, 0];
  const bb: Vec3 = [-0.06, 0.31, 0];
  const seatTop: Vec3 = [-0.25, 0.86, 0];
  const headTop: Vec3 = [0.34, 0.9, 0];
  const headBottom: Vec3 = [0.41, 0.63, 0];
  const handlebarY = 1.0;
  const handlebarX = 0.29;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <Wheel center={frontHub} />
      <Wheel center={rearHub} />

      {/* 挡泥板 */}
      <Fender center={rearHub} startAngle={0.22} color={FRAME_DARK} />
      <Fender center={frontHub} startAngle={-0.36} color={FRAME_DARK} />

      {/* 车架主三角 */}
      <Tube from={bb} to={seatTop} radius={0.019} color={FRAME} />
      <Tube from={bb} to={headBottom} radius={0.021} color={FRAME} />
      <Tube from={seatTop} to={headTop} radius={0.016} color={FRAME} />
      <Tube from={headBottom} to={headTop} radius={0.021} color={FRAME} />

      {/* 后三角：双后上叉 / 后下叉（带 z 偏移，侧面看得出立体） */}
      <Tube from={[seatTop[0], seatTop[1] - 0.03, 0.04]} to={[-0.48, 0.364, 0.045]} radius={0.01} color={FRAME} />
      <Tube from={[seatTop[0], seatTop[1] - 0.03, -0.04]} to={[-0.48, 0.364, -0.045]} radius={0.01} color={FRAME} />
      <Tube from={[-0.06, 0.31, 0.045]} to={[-0.48, 0.364, 0.045]} radius={0.011} color={FRAME} />
      <Tube from={[-0.06, 0.31, -0.045]} to={[-0.48, 0.364, -0.045]} radius={0.011} color={FRAME} />

      {/* 前叉双刀 */}
      <Tube from={[0.41, 0.63, 0.045]} to={[0.48, 0.364, 0.045]} radius={0.013} color={FRAME_DARK} />
      <Tube from={[0.41, 0.63, -0.045]} to={[0.48, 0.364, -0.045]} radius={0.013} color={FRAME_DARK} />

      {/* 座管 + 车座 */}
      <Tube from={seatTop} to={[-0.305, 0.9, 0]} radius={0.015} color={METAL} />
      <ToonBox
        size={[0.18, 0.055, 0.155]}
        position={[-0.36, 0.915, 0]}
        color={DARK}
        outline={0.008}
      />
      <ToonBox
        size={[0.14, 0.045, 0.085]}
        position={[-0.225, 0.912, 0]}
        color={DARK}
        outline={0}
      />

      {/* 车把立管 + 横把 + 握把 + 刹车把 + 铃铛 */}
      <Tube from={headTop} to={[handlebarX, handlebarY, 0]} radius={0.016} color={METAL} />
      <ToonCylinder
        radiusTop={0.015}
        radiusBottom={0.015}
        height={0.46}
        radialSegments={8}
        position={[handlebarX, handlebarY, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        color={METAL}
        outline={0.006}
      />
      {[0.235, -0.235].map((z) => (
        <ToonCylinder
          key={z}
          radiusTop={0.021}
          radiusBottom={0.021}
          height={0.1}
          radialSegments={8}
          position={[handlebarX, handlebarY, z]}
          rotation={[Math.PI / 2, 0, 0]}
          color={DARK}
          outline={0.006}
        />
      ))}
      <Tube from={[0.31, 0.985, 0.17]} to={[0.37, 0.93, 0.21]} radius={0.007} color={DARK} outline={0} />
      <Tube from={[0.31, 0.985, -0.17]} to={[0.37, 0.93, -0.21]} radius={0.007} color={DARK} outline={0} />
      <ToonCylinder
        radiusTop={0.031}
        radiusBottom={0.031}
        height={0.026}
        radialSegments={10}
        position={[handlebarX + 0.01, handlebarY + 0.035, 0.13]}
        color={RIM}
        outline={0.006}
      />

      {/* 前车筐 */}
      <FrontBasket />

      {/* 后货架 */}
      <ToonBox size={[0.3, 0.014, 0.22]} position={[-0.55, 0.72, 0]} color={METAL} outline={0.006} />
      <Tube from={[-0.68, 0.72, 0.09]} to={[-0.48, 0.39, 0.045]} radius={0.008} color={METAL} outline={0} />
      <Tube from={[-0.68, 0.72, -0.09]} to={[-0.48, 0.39, -0.045]} radius={0.008} color={METAL} outline={0} />
      <Tube from={[-0.42, 0.72, 0.09]} to={[-0.29, 0.82, 0.04]} radius={0.008} color={METAL} outline={0} />
      <Tube from={[-0.42, 0.72, -0.09]} to={[-0.29, 0.82, -0.04]} radius={0.008} color={METAL} outline={0} />
      {/* 后反光片 */}
      <ToonBox size={[0.014, 0.03, 0.06]} position={[-0.705, 0.7, 0]} color={PALETTE.neonPink} outline={0} />

      {/* 牙盘 + 飞轮 + 链条 */}
      <mesh position={[-0.06, 0.31, 0.06]}>
        <torusGeometry args={[0.085, 0.008, 5, 18]} />
        <Toon color={RIM} />
      </mesh>
      <mesh position={[-0.48, 0.364, 0.06]}>
        <torusGeometry args={[0.045, 0.007, 5, 14]} />
        <Toon color={METAL} />
      </mesh>
      <Tube from={[-0.06, 0.39, 0.06]} to={[-0.46, 0.395, 0.06]} radius={0.0055} color={DARK} outline={0} />
      <Tube from={[-0.06, 0.23, 0.06]} to={[-0.46, 0.335, 0.06]} radius={0.0055} color={DARK} outline={0} />

      {/* 曲柄 + 脚踏 */}
      <Tube from={[-0.06, 0.31, 0.075]} to={[-0.015, 0.155, 0.075]} radius={0.011} color={METAL} outline={0} />
      <ToonBox size={[0.085, 0.018, 0.055]} position={[-0.005, 0.148, 0.075]} color={DARK} outline={0} />
      <Tube from={[-0.06, 0.31, -0.075]} to={[-0.105, 0.465, -0.075]} radius={0.011} color={METAL} outline={0} />
      <ToonBox size={[0.085, 0.018, 0.055]} position={[-0.115, 0.472, -0.075]} color={DARK} outline={0} />

      {/* 脚撑：斜撑到地面，车看起来是停稳的 */}
      <Tube from={[-0.43, 0.3, 0.055]} to={[-0.52, 0.012, 0.15]} radius={0.011} color={METAL} outline={0.006} />
      <ToonBox size={[0.035, 0.012, 0.055]} position={[-0.525, 0.006, 0.155]} color={DARK} outline={0} />

      {/* 车锁/小细节：座管下的小包，拉开剪影 */}
      <ToonBox size={[0.12, 0.1, 0.06]} position={[-0.3, 0.79, 0.045]} color={DARK} outline={0.006} />
    </group>
  );
}
