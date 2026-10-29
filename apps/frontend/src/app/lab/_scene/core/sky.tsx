"use client";

import { useMemo } from "react";
import * as THREE from "three";

/**
 * 夜色天幕：一个包住整个场景的球壳，用极轻的竖直渐变代替纯黑背景。
 * 上空偏蓝紫、贴地一点城市光污染的青灰，让雨丝和建筑轮廓有东西可以衬。
 * 只画一次（renderOrder 最小、不写深度），成本可以忽略。
 */
export function SkyDome() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        uniforms: {
          uTop: { value: new THREE.Color("#080f1e") },
          uHorizon: { value: new THREE.Color("#151f36") },
          uBottom: { value: new THREE.Color("#04060c") },
        },
        vertexShader: /* glsl */ `
          varying vec3 vLocal;
          void main() {
            vLocal = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vLocal;
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          uniform vec3 uBottom;
          void main() {
            float h = normalize(vLocal).y;
            vec3 color = h > 0.0
              ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
              : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.7));
            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    [],
  );

  return (
    <mesh material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[70, 32, 16]} />
    </mesh>
  );
}
