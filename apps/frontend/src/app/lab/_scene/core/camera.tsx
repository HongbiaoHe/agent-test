"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ComponentRef } from "react";
import * as THREE from "three";

import { CAMERA, type Vec3 } from "./scene-config";
import { easeInOutCubic, useAssemblyClock } from "./assembly";

/**
 * 第三人称观察机位：默认从西南方向俯看整个街角模型。
 * - 开场有一点点推近（会被用户拖拽/滚轮打断）
 * - 之后完全交给 OrbitControls：拖拽旋转、滚轮缩放，禁止平移以免模型跑出画面
 * - 视口比例变化时自动退到能装下整个底座的距离（竖屏不裁切）
 */

function fitDistance(aspect: number): number {
  const vFov = THREE.MathUtils.degToRad(CAMERA.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const vertical = CAMERA.fitRadius / Math.sin(vFov / 2);
  const horizontal = CAMERA.fitRadius / Math.sin(hFov / 2);
  // 竖屏时允许轻微裁掉底座两角，换取模型在手机上的可读性（仍可滚轮/双指缩小）
  const factor = aspect < 0.85 ? CAMERA.fitFactor * 0.9 : CAMERA.fitFactor;
  return Math.max(vertical, horizontal) * factor;
}

export function CameraRig() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, size } = useThree();
  const { start, reduced } = useAssemblyClock();

  const target = useMemo(
    () => new THREE.Vector3(...CAMERA.target),
    [],
  );
  const direction = useMemo(
    () => new THREE.Vector3(...CAMERA.direction).normalize(),
    [],
  );

  const introDone = useRef(false);
  const interacted = useRef(false);
  const distance = useRef(0);

  // 初始 / 视口变化时：按比例计算能装下模型的距离
  useEffect(() => {
    const aspect = size.width / size.height;
    const fit = fitDistance(aspect);
    distance.current = fit;
    if (!introDone.current) {
      const startDistance = fit * 1.35;
      camera.position
        .copy(target)
        .add(direction.clone().multiplyScalar(startDistance))
        .add(new THREE.Vector3(0, 2.2, 0));
    } else if (!interacted.current) {
      const offset = camera.position.clone().sub(target);
      const dir = offset.length() > 0.01 ? offset.normalize() : direction.clone();
      camera.position.copy(target).add(dir.multiplyScalar(fit));
    }
    camera.lookAt(target);
    controls.current?.update();
    // camera/gl 只是依赖稳定引用，避免重复触发
  }, [size.width, size.height, camera, target, direction]);

  useFrame(() => {
    if (introDone.current) return;
    if (start <= 0) return;
    const elapsed = (performance.now() - start) / 1000;
    const raw = reduced ? 1 : Math.min(1, elapsed / CAMERA.introDuration);
    const e = easeInOutCubic(raw);
    const fit = distance.current || fitDistance(size.width / size.height);
    const d = fit * (1.35 - 0.35 * e);
    camera.position
      .copy(target)
      .add(direction.clone().multiplyScalar(d))
      .add(new THREE.Vector3(0, 2.2 * (1 - e), 0));
    camera.lookAt(target);
    if (raw >= 1) introDone.current = true;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={CAMERA.target as Vec3}
      enablePan={false}
      enableDamping
      dampingFactor={0.07}
      rotateSpeed={0.65}
      zoomSpeed={0.8}
      minDistance={CAMERA.minDistance}
      maxDistance={CAMERA.maxDistance}
      minPolarAngle={0.02}
      maxPolarAngle={Math.PI / 2 - 0.055}
      onStart={() => {
        introDone.current = true;
        interacted.current = true;
      }}
    />
  );
}
