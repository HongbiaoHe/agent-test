"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";

import { GlowPuddle } from "./materials";
import { PALETTE, ROAD, SIDEWALK } from "./scene-config";

/**
 * 雨夜湿地面。
 *
 * 这里的反射没有用 drei 的 MeshReflectorMaterial（当前 three r186 下它的
 * HalfFloat 反射 RT 在本机全黑），而是用 three 官方 examples 的 Reflector，
 * 上面再压一层半透明湿沥青，让倒影变成「暗面里透出来」的亮度——
 * 既保留霓虹倒影，又不会像镜子一样假。
 *
 * 只铺最影响观感的店前前场（接住便利店所有灯）；马路用湿沥青高光 + 贴地光斑表现，
 * 省掉一整遍场景反射渲染，拖拽时才不会掉帧。
 */

/** 创建镜面，并把每帧反射改成每 3 帧更新一次（湿地面倒影不需要 60fps） */
function createThrottledMirror(
  width: number,
  depth: number,
  resolution: number,
  tint: string,
): THREE.Mesh {
  const mirror = new Reflector(new THREE.PlaneGeometry(width, depth), {
    clipBias: 0.003,
    textureWidth: resolution,
    textureHeight: resolution,
    color: tint,
  });
  mirror.rotation.x = -Math.PI / 2;

  const original = mirror.onBeforeRender;
  let tick = 0;
  mirror.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    tick += 1;
    if (tick % 3 !== 0) return;
    original.call(mirror, renderer, scene, camera, geometry, material, group);
  };
  return mirror;
}

function MirrorSurface({
  width,
  depth,
  position,
  resolution = 256,
  tint = "#93a2bd",
}: {
  width: number;
  depth: number;
  position: [number, number, number];
  resolution?: number;
  tint?: string;
}) {
  const mirror = useMemo(
    () => createThrottledMirror(width, depth, resolution, tint),
    [width, depth, resolution, tint],
  );

  useEffect(
    () => () => {
      mirror.geometry.dispose();
      if (Array.isArray(mirror.material)) {
        mirror.material.forEach((material) => material.dispose());
      } else {
        mirror.material.dispose();
      }
    },
    [mirror],
  );

  return <primitive object={mirror} position={position} />;
}

export function WetGround() {
  const forecourt = {
    width: SIDEWALK.x1 - SIDEWALK.x0,
    depth: SIDEWALK.z1 + 0.6,
    centerX: (SIDEWALK.x0 + SIDEWALK.x1) / 2,
    centerZ: (-0.6 + SIDEWALK.z1) / 2,
  };

  return (
    <group>
      {/* 马路：不反射，只做湿沥青高光（低粗糙度 → 灯光拉出长条高光） */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ROAD.topY + 0.004, 0]}
        receiveShadow
      >
        <planeGeometry args={[12, 12]} />
        <meshStandardMaterial
          color={PALETTE.asphalt}
          roughness={0.3}
          metalness={0.4}
        />
      </mesh>

      {/* 假反射：不在镜面区域的地面，用贴地光斑画出霓虹 / 暖光倒影 */}
      <GlowPuddle
        color={PALETTE.interiorBright}
        size={1}
        opacity={0.3}
        position={[0.9, ROAD.topY + 0.016, 4.3]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[2.2, 4.6, 1]}
      />
      <GlowPuddle
        color={PALETTE.lampWarm}
        size={1}
        opacity={0.42}
        position={[3.3, ROAD.topY + 0.016, 3.8]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[1.3, 3.2, 1]}
      />
      <GlowPuddle
        color={PALETTE.neonCyan}
        size={1}
        opacity={0.3}
        position={[-3.0, SIDEWALK.topY + 0.012, -2.0]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[2.8, 1.8, 1]}
      />
      <GlowPuddle
        color={PALETTE.neonPink}
        size={1}
        opacity={0.22}
        position={[4.9, SIDEWALK.topY + 0.012, -0.9]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[1.5, 1.9, 1]}
      />
      <GlowPuddle
        color={PALETTE.white}
        size={1}
        opacity={0.2}
        position={[-2.7, SIDEWALK.topY + 0.012, 1.6]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[2.3, 2.2, 1]}
      />

      {/* 前场：镜面 + 湿沥青面层 */}
      <MirrorSurface
        width={forecourt.width}
        depth={forecourt.depth}
        position={[
          forecourt.centerX,
          SIDEWALK.topY + 0.002,
          forecourt.centerZ,
        ]}
        resolution={320}
      />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[
          forecourt.centerX,
          SIDEWALK.topY + 0.008,
          forecourt.centerZ,
        ]}
        receiveShadow
      >
        <planeGeometry args={[forecourt.width, forecourt.depth]} />
        <meshStandardMaterial
          color={PALETTE.asphaltDark}
          transparent
          opacity={0.55}
          roughness={0.4}
          metalness={0.18}
        />
      </mesh>

    </group>
  );
}
