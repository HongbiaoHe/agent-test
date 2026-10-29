"use client";

import { Outlines } from "@react-three/drei";
import * as THREE from "three";

import { PALETTE, type Vec3 } from "./scene-config";

/**
 * 三渲二材质基座。
 *
 * 所有不发光物体统一用 MeshToonMaterial + 4 阶 gradientMap（硬边色阶）；
 * 轮廓线统一用 drei <Outlines>（反向外扩），只加在「剪影重要」的物体上。
 * 发光面（招牌 / 灯箱 / 屏幕）用不受光的 MeshBasicMaterial，配合 Bloom 出光晕。
 */

export const OUTLINE_COLOR = PALETTE.outline;

const GRADIENT_STEPS = new Uint8Array([64, 128, 196, 255]);

let gradientMap: THREE.DataTexture | null = null;

/** 4 阶 toon ramp：阴影 → 中调 → 亮部 → 高光，共享一个纹理实例 */
export function getToonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const texture = new THREE.DataTexture(
    GRADIENT_STEPS,
    GRADIENT_STEPS.length,
    1,
    THREE.RedFormat,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  gradientMap = texture;
  return texture;
}

export type ToonMaterialProps = {
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  transparent?: boolean;
  map?: THREE.Texture | null;
  side?: THREE.Side;
  depthWrite?: boolean;
};

/** 作为 <mesh> 的子节点使用：<Toon color="#..." /> */
export function Toon({
  color,
  emissive,
  emissiveIntensity = 1,
  opacity = 1,
  transparent = false,
  map = null,
  side = THREE.FrontSide,
  depthWrite = true,
}: ToonMaterialProps) {
  return (
    <meshToonMaterial
      gradientMap={getToonGradient()}
      color={color}
      emissive={emissive ?? "#000000"}
      emissiveIntensity={emissiveIntensity}
      map={map}
      opacity={opacity}
      transparent={transparent}
      side={side}
      depthWrite={depthWrite}
    />
  );
}

type TransformProps = {
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
};

type OutlineProps = {
  /** 0 = 不加轮廓线；世界单位，小微件建议 0.01~0.02，建筑 0.025~0.04 */
  outline?: number;
  outlineColor?: string;
};

type ShadowProps = {
  castShadow?: boolean;
  receiveShadow?: boolean;
};

/** 带三渲二材质 + 轮廓线的方块（构件主力） */
export function ToonBox({
  size,
  color,
  outline = 0.016,
  outlineColor = OUTLINE_COLOR,
  castShadow = true,
  receiveShadow = true,
  position,
  rotation,
  scale,
  emissive,
  emissiveIntensity,
  opacity,
  transparent,
}: {
  size: Vec3;
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  transparent?: boolean;
} & TransformProps &
  OutlineProps &
  ShadowProps) {
  return (
    <mesh
      position={position}
      rotation={rotation}
      scale={scale}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <boxGeometry args={size} />
      <Toon
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        opacity={opacity}
        transparent={transparent}
      />
      {outline > 0 ? (
        <Outlines
          thickness={outline}
          color={outlineColor}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      ) : null}
    </mesh>
  );
}

/** 圆柱（电线杆 / 路灯杆 / 桶 / 花盆…），轴向 y */
export function ToonCylinder({
  radiusTop,
  radiusBottom,
  height,
  radialSegments = 12,
  color,
  outline = 0.012,
  outlineColor = OUTLINE_COLOR,
  castShadow = true,
  receiveShadow = true,
  position,
  rotation,
  scale,
}: {
  radiusTop: number;
  radiusBottom: number;
  height: number;
  radialSegments?: number;
  color: string;
} & TransformProps &
  OutlineProps &
  ShadowProps) {
  return (
    <mesh
      position={position}
      rotation={rotation}
      scale={scale}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <cylinderGeometry
        args={[radiusTop, radiusBottom, height, radialSegments]}
      />
      <Toon color={color} />
      {outline > 0 ? (
        <Outlines
          thickness={outline}
          color={outlineColor}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      ) : null}
    </mesh>
  );
}

/** 球（灯泡 / 镜子 / 蔬果…） */
export function ToonSphere({
  radius,
  color,
  segments = 16,
  outline = 0.01,
  outlineColor = OUTLINE_COLOR,
  castShadow = true,
  receiveShadow = true,
  position,
  rotation,
  scale,
}: {
  radius: number;
  color: string;
  segments?: number;
} & TransformProps &
  OutlineProps &
  ShadowProps) {
  return (
    <mesh
      position={position}
      rotation={rotation}
      scale={scale}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <sphereGeometry args={[radius, segments, Math.max(8, segments / 2)]} />
      <Toon color={color} />
      {outline > 0 ? (
        <Outlines
          thickness={outline}
          color={outlineColor}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      ) : null}
    </mesh>
  );
}

/** 自发光平面（招牌 / 灯箱 / 屏幕 / 海报）。默认不受光、不参与色调映射 */
export function NeonPanel({
  width,
  height,
  color = "#ffffff",
  map = null,
  opacity = 1,
  toneMapped = false,
  doubleSide = false,
  position,
  rotation,
}: {
  width: number;
  height: number;
  color?: string;
  map?: THREE.Texture | null;
  opacity?: number;
  toneMapped?: boolean;
  doubleSide?: boolean;
} & TransformProps) {
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial
        map={map}
        color={color}
        toneMapped={toneMapped}
        transparent={opacity < 1}
        opacity={opacity}
        side={doubleSide ? THREE.DoubleSide : THREE.FrontSide}
        depthWrite={!doubleSide}
      />
    </mesh>
  );
}

let glowTexture: THREE.Texture | null = null;

/** 白色径向渐变光晕纹理（实际颜色由 Sprite 的 color 相乘） */
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.72)");
  g.addColorStop(0.45, "rgba(255,255,255,0.26)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  glowTexture = texture;
  return texture;
}

/**
 * 广告牌 / 灯箱 / 路灯周围的空气光晕（additive sprite）。
 * 不写深度，放在发光体前面一点点即可自然叠在画面上。
 */
export function Glow({
  color,
  size = 1.6,
  opacity = 0.55,
  scale,
  position,
}: {
  color: string;
  size?: number;
  opacity?: number;
} & TransformProps) {
  const s = scale ?? [size, size, 1];
  return (
    <sprite position={position} scale={s}>
      <spriteMaterial
        map={getGlowTexture()}
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </sprite>
  );
}

/** 贴地的光斑 / 霓虹倒影（水平面），用于积水与灯下的漫反射 */
export function GlowPuddle({
  color,
  size = 1.6,
  opacity = 0.4,
  position,
  rotation = [0, 0, 0],
  scale,
}: {
  color: string;
  size?: number;
  opacity?: number;
} & TransformProps) {
  return (
    <mesh position={position} rotation={rotation} scale={scale}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial
        map={getGlowTexture()}
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

/** 便利店玻璃 / 自动门：薄薄一层反光，可透出室内货架 */
export function GlassPanel({
  width,
  height,
  position,
  rotation,
  opacity = 0.16,
  color = PALETTE.glass,
}: {
  width: number;
  height: number;
  opacity?: number;
  color?: string;
} & TransformProps) {
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[width, height]} />
      <meshPhysicalMaterial
        color={color}
        transparent
        opacity={opacity}
        roughness={0.08}
        metalness={0}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
