"use client";

import { Canvas } from "@react-three/fiber";

import { CAMERA } from "./scene-config";
import { Scene } from "./scene";

/**
 * Canvas 壳层：所有 3D 资源都在客户端加载（ssr:false 由页面层保证）。
 * DPR 上限 1.75，避免 4K 屏下 bloom 把帧率拖垮。
 */
export function Stage() {
  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{
        fov: CAMERA.fov,
        near: 0.1,
        far: 120,
        position: [-10.6, 8.2, 13.2],
      }}
      onCreated={({ gl }) => {
        gl.toneMappingExposure = 0.95;
      }}
      className="touch-none"
    >
      <Scene />
    </Canvas>
  );
}
