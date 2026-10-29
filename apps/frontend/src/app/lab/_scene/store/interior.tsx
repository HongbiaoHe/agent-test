"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { Glow, NeonPanel, ToonBox } from "../core/materials";
import { canvasTexture, roundRect } from "../core/textures";
import { PALETTE, TIMING } from "../core/scene-config";
import { Power } from "../core/assembly";
import { D } from "./dims";

/**
 * 室内：3 排暖光货架（商品用 InstancedMesh 合成一次绘制）、后墙发光饮料冷柜、
 * 收银台 + 收银机 + 热食柜、天花灯板。从玻璃外看进去要有东西，但不 overcrowd。
 */

const FLOOR = D.interiorFloorY;
const SHELF_ROWS = [-1.55, -2.6, -3.65] as const;
const SHELF_X = 0.3;
const SHELF_LEN = 2.8;
const SHELF_DEPTH = 0.55;
const BOARD_LEVELS = [0.64, 1.0, 1.36] as const;

type ProductItem = {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
};

const PRODUCT_COLORS = [
  PALETTE.brand,
  PALETTE.brandAlt,
  PALETTE.neonPink,
  PALETTE.neonCyan,
  PALETTE.lampWarm,
  PALETTE.leaf,
  PALETTE.neonGreen,
  PALETTE.neonViolet,
  PALETTE.warmLight,
  PALETTE.cream,
];

function buildProducts(): ProductItem[] {
  const items: ProductItem[] = [];
  SHELF_ROWS.forEach((rowZ, rowIndex) => {
    BOARD_LEVELS.forEach((boardY, levelIndex) => {
      for (let i = 0; i < 8; i += 1) {
        const w = 0.16 + ((i * 7 + rowIndex * 3 + levelIndex * 5) % 5) * 0.018;
        const h = 0.17 + ((i * 11 + rowIndex * 5 + levelIndex * 3) % 4) * 0.032;
        const x = SHELF_X - 1.3 + i * 0.36 + (levelIndex % 2) * 0.02;
        items.push({
          x,
          y: FLOOR + boardY + h / 2,
          z: rowZ + 0.07,
          w,
          h,
          d: 0.16,
          // 用质数步进打散色块，避免某一格窗前恰好全是浅色商品
          color:
            PRODUCT_COLORS[(i * 7 + rowIndex * 3 + levelIndex * 2) % PRODUCT_COLORS.length],
        });
      }
    });
  });
  return items;
}

function Products() {
  const items = useMemo(() => buildProducts(), []);
  const mesh = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // 商品用不受光材质：夜里货架面向街道的一面照不到室内灯，
    // 用 toon 会全部黑掉；basic + instanceColor 才有「暖光货架」的彩色包装感。
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const instanced = new THREE.InstancedMesh(geometry, material, items.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    items.forEach((item, index) => {
      dummy.position.set(item.x, item.y, item.z);
      dummy.scale.set(item.w, item.h, item.d);
      dummy.updateMatrix();
      instanced.setMatrixAt(index, dummy.matrix);
      instanced.setColorAt(index, color.set(item.color));
    });
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    instanced.receiveShadow = true;
    return instanced;
  }, [items]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    },
    [mesh],
  );

  return <primitive object={mesh} />;
}

function ShelfRows() {
  return (
    <Power delay={TIMING.power + 0.3}>
      {SHELF_ROWS.map((rowZ) => (
        <group key={rowZ}>
          {/* 底座 */}
          <ToonBox
            size={[SHELF_LEN, 0.1, SHELF_DEPTH]}
            position={[SHELF_X, FLOOR + 0.05, rowZ]}
            color={PALETTE.storeWallShade}
            outline={0.014}
            castShadow={false}
          />
          {/* 背板 */}
          <ToonBox
            size={[SHELF_LEN, 1.68, 0.05]}
            position={[SHELF_X, FLOOR + 0.84, rowZ - 0.25]}
            color={PALETTE.storeWallShade}
            outline={0}
            castShadow={false}
          />
          {/* 层板 + 顶板（微自发光，通电后货架像被灯带洗过） */}
          {[...BOARD_LEVELS, 1.68].map((level) => (
            <ToonBox
              key={level}
              size={[SHELF_LEN, 0.045, SHELF_DEPTH - 0.05]}
              position={[SHELF_X, FLOOR + level - 0.0225, rowZ - 0.01]}
              color={PALETTE.storeTrim}
              emissive={PALETTE.warmLight}
              emissiveIntensity={0.11}
              outline={0}
              castShadow={false}
            />
          ))}
          {/* 货架前缘暖光灯带 */}
          <NeonPanel
            width={SHELF_LEN - 0.2}
            height={0.05}
            color="#ffd9a5"
            opacity={0.78}
            position={[SHELF_X, FLOOR + 1.63, rowZ + 0.29]}
          />
          {/* 两侧立板 */}
          {[-1, 1].map((side) => (
            <ToonBox
              key={side}
              size={[0.05, 1.68, SHELF_DEPTH]}
              position={[SHELF_X + (side * SHELF_LEN) / 2, FLOOR + 0.84, rowZ]}
              color={PALETTE.storeWallShade}
              outline={0}
              castShadow={false}
            />
          ))}
        </group>
      ))}
      {/* 货架区内的暖空气光，透过玻璃看进去有温度 */}
      <Glow color={PALETTE.interior} size={2.2} opacity={0.08} position={[0.3, 1.4, -1.15]} />
      <Glow color={PALETTE.interior} size={2.0} opacity={0.07} position={[0.3, 1.3, -2.3]} />
    </Power>
  );
}

function createFridgeTexture(): THREE.CanvasTexture {
  const colors = [
    PALETTE.brand,
    PALETTE.brandAlt,
    PALETTE.neonPink,
    PALETTE.neonCyan,
    PALETTE.lampWarm,
    PALETTE.white,
    PALETTE.leaf,
    PALETTE.neonGreen,
  ];
  return canvasTexture(1024, 640, (ctx, w, h) => {
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#f8f4e6");
    bg.addColorStop(1, "#e0dbc8");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    for (let row = 0; row < 3; row += 1) {
      const shelfY = h * (0.3 + row * 0.23);
      ctx.fillStyle = "rgba(58, 70, 64, 0.35)";
      ctx.fillRect(0, shelfY, w, 12);
      for (let i = 0; i < 13; i += 1) {
        const bottleW = 32 + (i % 3) * 6;
        const bottleH = 88 + ((i * 13) % 3) * 14;
        const x = 20 + i * 76;
        const y = shelfY - bottleH;
        ctx.fillStyle = colors[(i + row * 3) % colors.length];
        roundRect(ctx, x, y, bottleW, bottleH, 9);
        ctx.fill();
        ctx.fillStyle = "#e8e4d8";
        ctx.fillRect(x + bottleW / 2 - 5, y - 9, 10, 12);
        ctx.fillStyle = "rgba(255,255,255,0.32)";
        ctx.fillRect(x + 6, y + 10, 5, bottleH - 24);
      }
    }

    // 两扇玻璃门的竖向门缝
    ctx.fillStyle = "rgba(28, 38, 40, 0.55)";
    ctx.fillRect(w / 3 - 6, 0, 12, h);
    ctx.fillRect((w * 2) / 3 - 6, 0, 12, h);
    // 顶部灯管泛光
    const top = ctx.createLinearGradient(0, 0, 0, h * 0.16);
    top.addColorStop(0, "rgba(255,255,255,0.9)");
    top.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, w, h * 0.16);
    // 底部踢板
    ctx.fillStyle = "#28302f";
    ctx.fillRect(0, h - 42, w, 42);
  });
}

function Fridge() {
  const texture = useMemo(() => createFridgeTexture(), []);
  const bodyY = FLOOR + 0.95;
  return (
    <group>
      <ToonBox
        size={[2.8, 1.9, 0.55]}
        position={[0.7, bodyY, -4.45]}
        color={PALETTE.glassDark}
        outline={0.02}
      />
      <ToonBox
        size={[2.8, 0.12, 0.52]}
        position={[0.7, FLOOR + 0.06, -4.45]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <Power delay={TIMING.power + 0.4}>
        <NeonPanel
          width={2.6}
          height={1.58}
          map={texture}
          opacity={0.97}
          position={[0.7, FLOOR + 0.22 + 0.79, -4.168]}
        />
        <NeonPanel
          width={2.52}
          height={0.1}
          color="#ffe9c4"
          opacity={0.9}
          position={[0.7, FLOOR + 1.87, -4.168]}
        />
        <Glow
          color="#ffe9c4"
          size={1.7}
          opacity={0.16}
          position={[-0.1, 1.2, -4.0]}
        />
        <Glow
          color="#ffe9c4"
          size={1.7}
          opacity={0.16}
          position={[1.5, 1.2, -4.0]}
        />
      </Power>
      {/* 冷柜门的金属分隔条 */}
      {[-0.87, 0.87].map((offset) => (
        <ToonBox
          key={offset}
          size={[0.05, 1.62, 0.04]}
          position={[0.7 + offset, FLOOR + 1.01, -4.15]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}
    </group>
  );
}

function Counter() {
  return (
    <group>
      <ToonBox
        size={[1.7, 0.88, 0.6]}
        position={[2.95, FLOOR + 0.44, -1.2]}
        color={PALETTE.storeWallShade}
        outline={0.018}
      />
      <ToonBox
        size={[1.8, 0.07, 0.68]}
        position={[2.95, FLOOR + 0.915, -1.2]}
        color={PALETTE.shelf}
        outline={0.012}
      />
      {/* 收银机 */}
      <ToonBox
        size={[0.36, 0.3, 0.26]}
        position={[2.45, FLOOR + 1.13, -1.3]}
        color={PALETTE.darkMetal}
        outline={0.012}
      />
      {/* 热食柜 */}
      <ToonBox
        size={[0.5, 0.38, 0.4]}
        position={[3.5, FLOOR + 1.15, -1.15]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <Power delay={TIMING.power + 0.55}>
        <NeonPanel
          width={0.3}
          height={0.2}
          color="#a8e8dc"
          opacity={0.92}
          position={[2.45, FLOOR + 1.31, -1.16]}
          rotation={[-0.32, 0, 0]}
        />
        <NeonPanel
          width={0.42}
          height={0.24}
          color="#ffcf87"
          opacity={0.9}
          position={[3.5, FLOOR + 1.16, -0.945]}
        />
        <Glow
          color={PALETTE.warmLight}
          size={0.9}
          opacity={0.18}
          position={[3.5, 1.5, -0.8]}
        />
      </Power>
      {/* 收银台后靠东墙的背柜 */}
      <ToonBox
        size={[0.32, 1.7, 1.2]}
        position={[3.87, FLOOR + 0.85, -2.2]}
        color={PALETTE.storeWallShade}
        outline={0.014}
        castShadow={false}
      />
      {[FLOOR + 0.62, FLOOR + 1.06, FLOOR + 1.5].map((y) => (
        <ToonBox
          key={y}
          size={[0.34, 0.04, 1.14]}
          position={[3.86, y, -2.2]}
          color={PALETTE.shelf}
          outline={0}
          castShadow={false}
        />
      ))}
    </group>
  );
}

function CeilingLights() {
  const panels: [number, number][] = [
    [0.0, -1.7],
    [0.0, -3.1],
    [2.6, -2.4],
  ];
  return (
    <Power delay={TIMING.power + 0.2}>
      {panels.map(([x, z]) => (
        <group key={`${x}-${z}`}>
          <NeonPanel
            width={1.15}
            height={0.55}
            color="#ffe7bd"
            opacity={0.85}
            position={[x, D.ceilingY - 0.038, z]}
            rotation={[Math.PI / 2, 0, 0]}
          />
          <Glow color={PALETTE.interior} size={1.4} opacity={0.13} position={[x, D.ceilingY - 0.25, z]} />
        </group>
      ))}
    </Power>
  );
}

/** 收银台旁 / 门口的两个小物件，拉开室内层次 */
function InteriorExtras() {
  const magazines = [
    PALETTE.brandAlt,
    PALETTE.neonPink,
    PALETTE.brand,
    PALETTE.neonCyan,
    PALETTE.cream,
    PALETTE.lampWarm,
  ];
  return (
    <group>
      {/* 西侧窗前的杂志架 */}
      <ToonBox
        size={[0.64, 0.5, 0.32]}
        position={[-1.32, FLOOR + 0.25, -0.98]}
        color={PALETTE.woodLight}
        outline={0.012}
        castShadow={false}
      />
      {magazines.map((color, index) => (
        <ToonBox
          key={color + index}
          size={[0.075, 0.24, 0.02]}
          position={[-1.55 + index * 0.09, FLOOR + 0.62, -0.955]}
          rotation={[-0.26, 0, 0]}
          color={color}
          outline={0}
          castShadow={false}
        />
      ))}
      {/* 门口购物篮 */}
      <ToonBox
        size={[0.46, 0.13, 0.32]}
        position={[1.85, FLOOR + 0.065, -1.05]}
        color={PALETTE.brand}
        outline={0.01}
        castShadow={false}
      />
      <ToonBox
        size={[0.44, 0.12, 0.3]}
        position={[1.86, FLOOR + 0.19, -1.05]}
        color={PALETTE.brandAlt}
        outline={0.01}
        castShadow={false}
      />
    </group>
  );
}

export function Interior() {
  return (
    <group>
      <ShelfRows />
      <Products />
      <Fridge />
      <Counter />
      <CeilingLights />
      <InteriorExtras />
    </group>
  );
}
