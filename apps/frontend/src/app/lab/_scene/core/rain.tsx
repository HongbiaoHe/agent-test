"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { easeOutCubic, useAssemblyClock } from "./assembly";
import { PALETTE, TIMING } from "./scene-config";

/**
 * 雨。两层：
 * 1) 雨丝：自定义 ShaderMaterial 的 Points，GPU 里循环下落，零 CPU 开销；
 *    店体范围内低于屋顶的粒子会被裁掉，屋里不下雨。
 * 2) 地面涟漪：路面积水上循环扩散的小圆环。
 */

const RAIN_COUNT = 2200;
const AREA = 13.4;
const HEIGHT = 9.6;
const DROP_LENGTH = 0.13;

function makeStreakTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.7)");
  gradient.addColorStop(0.75, "rgba(255,255,255,0.9)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(15, 0, 2, 64);
  ctx.filter = "blur(1px)";
  ctx.fillRect(14, 0, 4, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  uniform float uFallSpeed;
  uniform float uPixelScale;
  uniform float uDropLength;
  attribute float aSpeed;
  varying float vVisible;

  void main() {
    vec3 p = position;
    float fall = mod(p.y - uTime * uFallSpeed * aSpeed, uHeight);
    p.y = fall;
    p.x += (uHeight - fall) * 0.055;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uDropLength * uPixelScale / max(0.5, -mv.z);

    vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;
    bool insideStore = world.x > -2.0 && world.x < 4.35 && world.z > -5.15 && world.z < -0.45;
    vVisible = insideStore && world.y < 3.45 ? 0.0 : 1.0;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vVisible;

  void main() {
    float alpha = texture2D(uMap, gl_PointCoord).a * uOpacity * vVisible;
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export function Rain() {
  const points = useRef<THREE.Points>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const { size, camera, gl } = useThree();
  const { start, reduced } = useAssemblyClock();
  const streak = useMemo(() => makeStreakTexture(), []);

  const geometry = useMemo(() => {
    const positions = new Float32Array(RAIN_COUNT * 3);
    const speeds = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i += 1) {
      const seedX = Math.sin(i * 12.9898) * 43758.5453;
      const seedY = Math.sin(i * 78.233) * 43758.5453;
      const seedZ = Math.sin(i * 37.719) * 43758.5453;
      positions[i * 3] = (seedX - Math.floor(seedX) - 0.5) * AREA;
      positions[i * 3 + 1] = (seedY - Math.floor(seedY)) * HEIGHT;
      positions[i * 3 + 2] = (seedZ - Math.floor(seedZ) - 0.5) * AREA;
      speeds[i] = 0.72 + ((i * 37) % 100) / 100 * 0.55;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
    return geo;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const pixelScale = useMemo(() => {
    const fov = THREE.MathUtils.degToRad(
      camera instanceof THREE.PerspectiveCamera ? camera.fov : 36,
    );
    return (size.height * gl.getPixelRatio()) / (2 * Math.tan(fov / 2));
  }, [size.height, camera, gl]);

  useFrame((state) => {
    if (!material.current) return;
    const elapsed = start > 0 ? (performance.now() - start) / 1000 : 0;
    const power = reduced ? 1 : easeOutCubic(Math.min(1, Math.max(0, (elapsed - TIMING.rain) / 1.1)));
    material.current.uniforms.uTime.value = reduced ? 0 : state.clock.elapsedTime;
    material.current.uniforms.uOpacity.value = reduced ? 0.14 : power * 0.4;
    material.current.uniforms.uPixelScale.value = pixelScale;
  });

  return (
    <>
      <points ref={points} geometry={geometry} frustumCulled={false}>
        <shaderMaterial
          ref={material}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{
            uTime: { value: 0 },
            uHeight: { value: HEIGHT },
            uFallSpeed: { value: 9.0 },
            uPixelScale: { value: pixelScale },
            uDropLength: { value: DROP_LENGTH },
            uMap: { value: streak },
            uColor: { value: new THREE.Color(PALETTE.rain) },
            uOpacity: { value: 0 },
          }}
        />
      </points>

      <RainRipples />
    </>
  );
}

const RIPPLE_SPOTS: Array<[number, number, number]> = [
  // 南侧马路
  [-4.4, 0.035, 4.3],
  [-2.6, 0.035, 3.6],
  [-1.1, 0.035, 5.1],
  [0.6, 0.035, 4.2],
  [2.1, 0.035, 3.3],
  [3.4, 0.035, 5.2],
  [4.8, 0.035, 4.1],
  // 西侧马路
  [-4.2, 0.035, -2.4],
  [-5.2, 0.035, -0.6],
  [-4.6, 0.035, 1.6],
  [-5.3, 0.035, 3.6],
  // 人行道积水的涟漪（和地面水洼对齐）
  [1.5, 0.192, 1.72],
  [4.86, 0.192, -1.45],
];

export function RainRipples() {
  const meshes = useRef<Array<THREE.Mesh | null>>([]);
  const { start, reduced } = useAssemblyClock();
  const geometry = useMemo(() => new THREE.RingGeometry(0.06, 0.085, 20), []);
  const materials = useMemo(
    () =>
      RIPPLE_SPOTS.map(
        () =>
          new THREE.MeshBasicMaterial({
            color: PALETTE.rain,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
      ),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      materials.forEach((material) => material.dispose());
    },
    [geometry, materials],
  );

  useFrame(() => {
    const elapsed = start > 0 ? (performance.now() - start) / 1000 : 0;
    const rainAmount = start > 0 ? Math.min(1, Math.max(0, (elapsed - TIMING.rain) / 1.4)) : 0;
    meshes.current.forEach((mesh, index) => {
      if (!mesh) return;
      const offset = (index * 0.37) % 1;
      const phase = reduced ? 0.5 : (elapsed * 0.75 + offset) % 1;
      const scale = 0.25 + phase * 1.7;
      mesh.scale.setScalar(scale);
      const meshMaterial = mesh.material;
      if (meshMaterial instanceof THREE.MeshBasicMaterial) {
        meshMaterial.opacity = (1 - phase) * 0.4 * rainAmount;
      }
      mesh.visible = rainAmount > 0.01;
    });
  });

  return (
    <group>
      {RIPPLE_SPOTS.map(([x, y, z], index) => (
        <mesh
          key={`${x}-${z}`}
          ref={(node) => {
            meshes.current[index] = node;
          }}
          position={[x, y, z]}
          rotation={[-Math.PI / 2, 0, 0]}
          geometry={geometry}
          material={materials[index]}
        />
      ))}
    </group>
  );
}
