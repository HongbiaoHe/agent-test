"use client";

import { useMemo } from "react";
import * as THREE from "three";

import { GlowPuddle, Toon, ToonBox, ToonCylinder } from "../core/materials";
import {
  PALETTE,
  PUDDLES,
  ROAD,
  SIDEWALK,
  type Vec3,
} from "../core/scene-config";
import { createTileTexture, mixHex } from "../core/textures";

import { createGrateTexture, createManholeTexture } from "./textures";

/**
 * 街道地面：人行道铺装 / 路缘 / 排水沟 / 井盖（Paving），
 * 马路标线（Markings）与积水（Puddles）。
 *
 * 湿地反射由 core/wet-ground.tsx 统一提供，这里所有贴地构件都必须压在
 * 反射面之上：马路 y≈0.042，人行道前场 y≈0.192，其余人行道底面 y=0.18。
 */

/** 马路标线高度（湿沥青面层 y=0.028 之上） */
const MARK_ROAD_Y = ROAD.topY + 0.022;
/** 前场标线高度（镜面 0.182 + 湿沥青 0.188 之上） */
const MARK_WALK_Y = SIDEWALK.topY + 0.012;
/** 人行道构件落地高度（略微沉入湿面层，避免悬浮） */
const WALK_BASE_Y = SIDEWALK.topY;

const CURB_TOP = mixHex(PALETTE.curb, PALETTE.white, 0.38);
const CURB_CAP_Y = 0.227;

type RectMark = { x: number; z: number; w: number; d: number };

/* ------------------------------------------------------------ 人行道铺装 */

function TilePatch({
  position,
  size,
  map,
}: {
  position: Vec3;
  size: [number, number];
  map: THREE.Texture;
}) {
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={size} />
      <Toon color="#ffffff" map={map} />
    </mesh>
  );
}

export function Paving() {
  // 三块地砖（避开便利店 footprint，免得盖住 store 的室内地面）
  const tileTextures = useMemo(() => {
    const make = (repeatX: number, repeatZ: number) => {
      const texture = createTileTexture();
      texture.repeat.set(repeatX, repeatZ);
      return texture;
    };
    return {
      west: make(1.8 / 2.4, 5.4 / 2.4),
      north: make(6 / 2.4, 1.1 / 2.4),
      east: make(1.8 / 2.4, 5.4 / 2.4),
    };
  }, []);

  const grateMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: createGrateTexture(),
        color: "#b9c5d8",
        roughness: 0.55,
        metalness: 0.45,
      }),
    [],
  );

  const manholeMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: createManholeTexture(),
        roughness: 0.5,
        metalness: 0.4,
      }),
    [],
  );

  const southGrates = useMemo(() => [-2.4, 1.95, 3.4], []);
  const westGrates = useMemo(() => [-3.2, -0.8], []);

  return (
    <group>
      {/* 人行道基座（顶面 y=0.18） */}
      <ToonBox
        size={[
          SIDEWALK.x1 - SIDEWALK.x0,
          SIDEWALK.topY,
          SIDEWALK.z1 - SIDEWALK.z0,
        ]}
        position={[
          (SIDEWALK.x0 + SIDEWALK.x1) / 2,
          SIDEWALK.topY / 2,
          (SIDEWALK.z0 + SIDEWALK.z1) / 2,
        ]}
        color={PALETTE.sidewalk}
        outline={0}
        receiveShadow
      />

      {/* 地砖（西部 / 北侧 / 东侧，前场由湿反射面接管） */}
      <TilePatch
        position={[-2.7, SIDEWALK.topY + 0.001, -3.3]}
        size={[1.8, 5.4]}
        map={tileTextures.west}
      />
      <TilePatch
        position={[1.2, SIDEWALK.topY + 0.001, -5.45]}
        size={[6, 1.1]}
        map={tileTextures.north}
      />
      <TilePatch
        position={[5.1, SIDEWALK.topY + 0.001, -3.3]}
        size={[1.8, 5.4]}
        map={tileTextures.east}
      />

      {/* 南侧路缘石 */}
      <ToonBox
        size={[9.6, 0.21, 0.26]}
        position={[1.2, 0.105, 2.92]}
        color={PALETTE.curb}
        outline={0.008}
      />
      <ToonBox
        size={[9.6, 0.034, 0.26]}
        position={[1.2, CURB_CAP_Y, 2.92]}
        color={CURB_TOP}
        outline={0}
      />

      {/* 西侧路缘石 */}
      <ToonBox
        size={[0.26, 0.21, 8.8]}
        position={[-3.72, 0.105, -1.6]}
        color={PALETTE.curb}
        outline={0.008}
      />
      <ToonBox
        size={[0.26, 0.034, 8.8]}
        position={[-3.72, CURB_CAP_Y, -1.6]}
        color={CURB_TOP}
        outline={0}
      />

      {/* 排水明沟（两条路缘各一条深色凹槽） */}
      <ToonBox
        size={[9.5, 0.014, 0.16]}
        position={[1.2, ROAD.topY + 0.01, 3.13]}
        color={PALETTE.gutter}
        outline={0}
        receiveShadow
      />
      <ToonBox
        size={[0.16, 0.014, 8.5]}
        position={[-3.93, ROAD.topY + 0.01, -1.65]}
        color={PALETTE.gutter}
        outline={0}
        receiveShadow
      />

      {/* 金属格栅 */}
      {southGrates.map((x) => (
        <mesh
          key={`grate-s-${x}`}
          position={[x, ROAD.topY + 0.019, 3.13]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={grateMaterial}
        >
          <planeGeometry args={[0.52, 0.16]} />
        </mesh>
      ))}
      {westGrates.map((z) => (
        <mesh
          key={`grate-w-${z}`}
          position={[-3.93, ROAD.topY + 0.019, z]}
          rotation={[-Math.PI / 2, 0, Math.PI / 2]}
          material={grateMaterial}
        >
          <planeGeometry args={[0.52, 0.16]} />
        </mesh>
      ))}

      {/* 井盖：马路 (4.2, 4.6) */}
      <ToonCylinder
        radiusTop={0.38}
        radiusBottom={0.38}
        height={0.024}
        radialSegments={20}
        color={PALETTE.darkMetal}
        position={[4.2, ROAD.topY + 0.024, 4.6]}
        outline={0}
      />
      <mesh
        position={[4.2, ROAD.topY + 0.037, 4.6]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={manholeMaterial}
      >
        <circleGeometry args={[0.36, 20]} />
      </mesh>

      {/* 井盖：人行道前场 (0.2, 1.5) */}
      <ToonCylinder
        radiusTop={0.34}
        radiusBottom={0.34}
        height={0.022}
        radialSegments={20}
        color={PALETTE.darkMetal}
        position={[0.2, MARK_WALK_Y + 0.009, 1.5]}
        outline={0}
      />
      <mesh
        position={[0.2, MARK_WALK_Y + 0.0215, 1.5]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={manholeMaterial}
      >
        <circleGeometry args={[0.32, 20]} />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------- 马路标线 */

export function Markings() {
  const paint = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: PALETTE.white,
        roughness: 0.3,
        metalness: 0.08,
        emissive: new THREE.Color("#243049"),
        emissiveIntensity: 1,
      }),
    [],
  );

  // 南侧斑马线：5 条横条，z 3.05~5.65
  const southStripes = useMemo<RectMark[]>(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        x: -0.05,
        z: 3.25 + i * 0.55,
        w: 3,
        d: 0.4,
      })),
    [],
  );

  // 西侧斑马线：4 条纵条，x -5.85~-3.86，z 0.5~2.5
  const westStripes = useMemo<RectMark[]>(
    () =>
      Array.from({ length: 4 }, (_, i) => ({
        x: -5.68 + i * 0.55,
        z: 1.5,
        w: 0.34,
        d: 2,
      })),
    [],
  );

  // 中心虚线：南侧 z=4.55，西侧 x=-4.8
  const centerLines = useMemo<RectMark[]>(() => {
    const south = [-5.8, -4.2, -2.6, 1.9, 3.5, 5].map((x) => ({
      x: x + 0.4,
      z: 4.55,
      w: 0.8,
      d: 0.15,
    }));
    const west = [-5.6, -4, -2.4, -0.8, 2.9, 4.5].map((z) => ({
      x: -4.8,
      z: z + 0.4,
      w: 0.15,
      d: 0.8,
    }));
    return [...south, ...west];
  }, []);

  // 停车位 U 形边线（北端 z=0.9，避开小巷入口；东侧 x=5.9 不出底座）
  const parkingLines = useMemo<RectMark[]>(
    () => [
      { x: 4.4, z: 1.725, w: 0.09, d: 1.65 },
      { x: 5.9, z: 1.725, w: 0.09, d: 1.65 },
      { x: 5.15, z: 0.9, w: 1.59, d: 0.09 },
    ],
    [],
  );

  const roadMarks = useMemo(
    () => [...southStripes, ...westStripes, ...centerLines],
    [southStripes, westStripes, centerLines],
  );

  return (
    <group>
      {roadMarks.map((mark, index) => (
        <mesh
          key={`road-mark-${index}`}
          position={[mark.x, MARK_ROAD_Y, mark.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={paint}
          receiveShadow
        >
          <planeGeometry args={[mark.w, mark.d]} />
        </mesh>
      ))}

      {parkingLines.map((mark, index) => (
        <mesh
          key={`parking-${index}`}
          position={[mark.x, MARK_WALK_Y, mark.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={paint}
          receiveShadow
        >
          <planeGeometry args={[mark.w, mark.d]} />
        </mesh>
      ))}

      {/* 停车位混凝土轮挡 */}
      <group position={[5.15, WALK_BASE_Y, 1.05]}>
        <ToonBox
          size={[0.9, 0.12, 0.18]}
          position={[0, 0.06, 0]}
          color={PALETTE.concrete}
          outline={0.008}
        />
        <ToonBox
          size={[0.18, 0.006, 0.14]}
          position={[-0.24, 0.123, 0]}
          color={PALETTE.brandAlt}
          outline={0}
        />
        <ToonBox
          size={[0.18, 0.006, 0.14]}
          position={[0.24, 0.123, 0]}
          color={PALETTE.brandAlt}
          outline={0}
        />
      </group>
    </group>
  );
}

/* ----------------------------------------------------------------- 积水 */

/** 不规则椭圆水面（16 边扇面，半径带扰动） */
function puddleGeometry(rx: number, rz: number, seed: number): THREE.BufferGeometry {
  const geometry = new THREE.CircleGeometry(1, 18);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    if (x === 0 && y === 0) continue;
    const angle = Math.atan2(y, x);
    const wobble =
      0.84 +
      0.16 * (0.5 + 0.5 * Math.sin(angle * 3 + seed)) +
      0.05 * Math.sin(angle * 5 - seed);
    position.setXY(i, x * rx * wobble, y * rz * wobble);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export function Puddles() {
  const geometries = useMemo(
    () => PUDDLES.map((puddle, index) => puddleGeometry(puddle.rx, puddle.rz, index * 1.7)),
    [],
  );

  const water = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: PALETTE.water,
        roughness: 0.05,
        metalness: 0.45,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    [],
  );

  const rim = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#05080f",
        roughness: 0.35,
        metalness: 0.2,
      }),
    [],
  );

  return (
    <group>
      {PUDDLES.map((puddle, index) => (
        <group key={`puddle-${index}`} position={[puddle.x, 0, puddle.z]}>
          <mesh
            geometry={geometries[index]}
            material={rim}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, puddle.y - 0.002, 0]}
            scale={[1.06, 1.06, 1]}
            receiveShadow
          />
          <mesh
            geometry={geometries[index]}
            material={water}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, puddle.y, 0]}
          />
        </group>
      ))}

      {/* 两处霓虹/暖光在地面的弱反光，强化湿街的层次 */}
      <GlowPuddle
        color={PALETTE.neonCyan}
        size={1}
        opacity={0.1}
        position={[2.3, PUDDLES[1].y + 0.002, 3.5]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
      <GlowPuddle
        color={PALETTE.neonPink}
        size={0.9}
        opacity={0.1}
        position={[4.86, PUDDLES[5].y + 0.002, -1.45]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
    </group>
  );
}
