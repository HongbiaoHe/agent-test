"use client";

import { OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { collectFauna, updateFauna } from "./fauna";
import { applyPaletteMaterials, prepareIslandMaterials } from "./materials";
import type { Palette } from "./palettes";

const MODEL_URL = "/lab/island/island.glb";

type SceneProps = {
  palette: Palette;
  wireframe: boolean;
  autoRotate: boolean;
  animals: boolean;
  reducedMotion: boolean;
};

/**
 * 模型本体：glTF 只加载一次并克隆，之后所有动画/配色都在 three 对象上原地改，
 * 不触发 React 重渲染（材质与动画逻辑都在 _scene 下的纯模块里）。
 */
function IslandModel({
  palette,
  wireframe,
  animals,
  reducedMotion,
}: Omit<SceneProps, "autoRotate">) {
  const { scene } = useGLTF(MODEL_URL);
  const model = useMemo(() => scene.clone(true), [scene]);
  const island = useMemo(() => model.getObjectByName("Island") ?? null, [model]);
  const fauna = useMemo(() => collectFauna(model), [model]);

  useEffect(() => {
    prepareIslandMaterials(model);
  }, [model]);

  useEffect(() => {
    applyPaletteMaterials(model, palette, wireframe);
  }, [model, palette, wireframe]);

  useFrame((_, delta) => {
    if (!animals || reducedMotion) return;
    updateFauna(fauna, delta, island);
  });

  return <primitive object={model} />;
}

export function SceneStage({ palette, wireframe, autoRotate, animals, reducedMotion }: SceneProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [10.6, 6.9, 11.4], fov: 36, near: 0.1, far: 400 }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ gl }) => {
        // 与 Blender 的 Standard 视图变换对齐：不做色调映射，保留配色本身
        gl.toneMapping = THREE.NoToneMapping;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      <hemisphereLight
        color={palette.hemi.sky}
        groundColor={palette.hemi.ground}
        intensity={palette.hemi.intensity}
      />
      <directionalLight
        color={palette.key.color}
        intensity={palette.key.intensity}
        position={palette.key.position}
      />
      <directionalLight
        color={palette.fill.color}
        intensity={palette.fill.intensity}
        position={palette.fill.position}
      />

      <IslandModel
        palette={palette}
        wireframe={wireframe}
        animals={animals}
        reducedMotion={reducedMotion}
      />

      <OrbitControls
        target={[0, 0.1, 0]}
        enablePan={false}
        enableDamping
        dampingFactor={0.075}
        minDistance={7}
        maxDistance={40}
        maxPolarAngle={Math.PI * 0.62}
        autoRotate={autoRotate && !reducedMotion}
        autoRotateSpeed={1.5}
      />
    </Canvas>
  );
}

useGLTF.preload(MODEL_URL);
