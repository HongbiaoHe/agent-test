"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

import { Power } from "../core/assembly";
import { Glow, Toon, ToonBox, ToonCylinder, ToonSphere } from "../core/materials";
import { PALETTE, TIMING, type Vec3 } from "../core/scene-config";
import { ContactShadow } from "./shadow";

/**
 * 贩卖机旁的黑猫：坐姿、白胸、暖黄微发光眼睛，尾巴 useFrame 轻摆。
 * 原点在两只前爪之间的地面；整体 scale 0.82，坐在人行道 y=0.18 上。
 */

const FUR = PALETTE.darkMetal;
const FUR_RIM = PALETTE.baseRim;
const CHEST = PALETTE.cream;

function Eye({ x }: { x: number }) {
  return (
    <mesh position={[x, 0.375, 0.128]}>
      <sphereGeometry args={[0.0128, 10, 8]} />
      <Toon
        color="#2b210f"
        emissive={PALETTE.lampWarm}
        emissiveIntensity={1.9}
      />
    </mesh>
  );
}

export function Cat({
  position,
  rotationY,
}: {
  position: Vec3;
  rotationY: number;
}) {
  const tail = useRef<THREE.Group>(null);

  useFrame((state) => {
    const group = tail.current;
    if (!group) return;
    const t = state.clock.elapsedTime;
    group.rotation.z = Math.sin(t * 1.35) * 0.2;
    group.rotation.y = 0.45 + Math.sin(t * 0.85 + 0.7) * 0.13;
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <group scale={0.95}>
        <ContactShadow size={0.38} position={[0, 0.0015, -0.01]} opacity={0.38} />
        {/* 后腿 / 臀部 */}
        <ToonSphere
          radius={0.115}
          position={[0, 0.125, -0.025]}
          scale={[1, 1.02, 1.15]}
          color={FUR}
          outline={0.01}
        />
        {/* 上身 */}
        <ToonSphere
          radius={0.095}
          position={[0, 0.235, 0.03]}
          scale={[0.92, 1.3, 0.88]}
          color={FUR}
          outline={0.008}
        />
        {/* 白胸毛 */}
        <ToonSphere
          radius={0.058}
          position={[0, 0.245, 0.085]}
          scale={[0.82, 1.1, 0.55]}
          color={CHEST}
          outline={0}
        />
        {/* 头 */}
        <ToonSphere
          radius={0.078}
          position={[0, 0.365, 0.055]}
          scale={[1, 0.94, 0.95]}
          color={FUR}
          outline={0.008}
        />
        {/* 口鼻 */}
        <ToonSphere
          radius={0.034}
          position={[0, 0.342, 0.118]}
          scale={[1.15, 0.8, 0.9]}
          color={CHEST}
          outline={0}
        />
        {/* 耳朵（外耳 + 内耳） */}
        {[-1, 1].map((side) => (
          <group key={side}>
            <mesh
              position={[side * 0.046, 0.43, 0.05]}
              rotation={[0, 0, side * -0.22]}
            >
              <coneGeometry args={[0.033, 0.08, 4]} />
              <Toon color={FUR} />
            </mesh>
            <mesh
              position={[side * 0.046, 0.428, 0.063]}
              rotation={[0, 0, side * -0.22]}
            >
              <coneGeometry args={[0.019, 0.05, 4]} />
              <Toon color={FUR_RIM} />
            </mesh>
          </group>
        ))}
        {/* 前腿 + 爪 */}
        {[-1, 1].map((side) => (
          <group key={side}>
            <ToonBox
              size={[0.042, 0.155, 0.048]}
              position={[side * 0.052, 0.085, 0.09]}
              color={FUR}
              outline={0.006}
            />
            <ToonBox
              size={[0.058, 0.03, 0.075]}
              position={[side * 0.052, 0.018, 0.11]}
              color={FUR_RIM}
              outline={0.004}
            />
          </group>
        ))}
        {/* 尾巴：三段，根部挂在臀部后方 */}
        <group ref={tail} position={[-0.02, 0.075, -0.115]} rotation={[0.3, 0.45, 0]}>
          <ToonCylinder
            radiusTop={0.018}
            radiusBottom={0.022}
            height={0.1}
            position={[0, 0.05, 0]}
            color={FUR}
            outline={0.005}
          />
          <group position={[0, 0.1, 0]} rotation={[0.55, 0, 0]}>
            <ToonCylinder
              radiusTop={0.015}
              radiusBottom={0.018}
              height={0.09}
              position={[0, 0.045, 0]}
              color={FUR}
              outline={0.004}
            />
            <group position={[0, 0.09, 0]} rotation={[0.45, 0, 0]}>
              <ToonCylinder
                radiusTop={0.01}
                radiusBottom={0.015}
                height={0.08}
                position={[0, 0.04, 0]}
                color={FUR_RIM}
                outline={0.004}
              />
            </group>
          </group>
        </group>
        {/* 眼睛 + 一点暖色氛围光 */}
        <Power delay={TIMING.power + 0.6}>
          <Eye x={-0.03} />
          <Eye x={0.03} />
          <Glow
            color={PALETTE.lampWarm}
            size={0.42}
            opacity={0.14}
            position={[0, 0.37, 0.16]}
          />
        </Power>
      </group>
    </group>
  );
}
