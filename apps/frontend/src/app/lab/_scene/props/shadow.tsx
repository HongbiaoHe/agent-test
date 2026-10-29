"use client";

import * as THREE from "three";

import type { Vec3 } from "../core/scene-config";

/**
 * 接触阴影（一次性 canvas 径向渐变 + 加色为 0 的黑色平面）。
 *
 * 场景里只有月光一盏投影灯，巷子/贩卖机背面完全在阴影里，小物件看起来会「浮」。
 * 这里用一张共享的软边黑色贴片贴在物件脚下补一个假 AO —— 不是光源，也不是反射面，
 * 只是一张透明贴地平面，成本极低，但能立刻把箱子、盆栽、猫「压」到地上。
 */

let shadowTexture: THREE.CanvasTexture | null = null;

function getShadowTexture(): THREE.CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.04,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, "rgba(0,0,0,0.78)");
  gradient.addColorStop(0.45, "rgba(0,0,0,0.38)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  shadowTexture = texture;
  return texture;
}

export function ContactShadow({
  size,
  position,
  opacity = 0.55,
}: {
  size: number;
  position: Vec3;
  opacity?: number;
}) {
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial
        map={getShadowTexture()}
        color="#000000"
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
