"use client";

import { useMemo } from "react";

import { NeonPanel, ToonBox, ToonCylinder } from "../core/materials";
import { createTextPanelTexture } from "../core/textures";
import { PALETTE, type Vec3 } from "../core/scene-config";
import { D, WALL_CY, WALL_H } from "./dims";

/**
 * 建筑结构：室内地坪 / 吊顶、三面实墙、角柱、屋面、女儿墙。
 * 南立面与西立面前半段是橱窗（见 storefront.tsx），这里只做「背墙 + 上沿墙带」。
 */
export function Shell() {
  const deliverySign = useMemo(
    () =>
      createTextPanelTexture({
        width: 256,
        height: 128,
        bg: "#e7e0d0",
        border: "#5c5346",
        borderWidth: 6,
        radius: 4,
        lines: [
          { text: "納品口", size: 44, color: "#4a4438", weight: 800 },
          { text: "DELIVERY", size: 26, color: "#7a7264", weight: 700, family: "sans-serif" },
        ],
      }),
    [],
  );
  const parapetH = D.parapetTopY - D.wallTopY;
  const parapetCY = D.wallTopY + parapetH / 2;
  const upperBandCY = (D.glassTopY + D.wallTopY) / 2;
  const upperBandH = D.wallTopY - D.glassTopY;

  const parapets: { size: Vec3; position: Vec3 }[] = [
    { size: [D.w, parapetH, 0.2], position: [D.cx, parapetCY, D.z1 - 0.1] },
    { size: [D.w, parapetH, 0.2], position: [D.cx, parapetCY, D.z0 + 0.1] },
    { size: [0.2, parapetH, D.d - 0.4], position: [D.x0 + 0.1, parapetCY, D.cz] },
    { size: [0.2, parapetH, D.d - 0.4], position: [D.x1 - 0.1, parapetCY, D.cz] },
  ];

  return (
    <group>
      {/* 室内地坪（比人行道高 4cm，压在湿反射面之上） */}
      <ToonBox
        size={[D.w - 0.12, 0.04, D.d - 0.12]}
        position={[D.cx, D.floorY + 0.02, D.cz]}
        color={PALETTE.shelf}
        outline={0}
        castShadow={false}
      />

      {/* 室内吊顶：压住室内高度，让灯光在有限空间里反射 */}
      <ToonBox
        size={[D.w - 0.16, 0.06, D.d - 0.16]}
        position={[D.cx, D.ceilingY, D.cz]}
        color={PALETTE.shelf}
        outline={0}
        castShadow={false}
      />

      {/* 北墙 / 东墙（服务面）：实墙，背光面用暗一档的墙色 */}
      <ToonBox
        size={[D.w, WALL_H, D.wallT]}
        position={[D.cx, WALL_CY, D.z0 + D.wallT / 2]}
        color={PALETTE.storeWallShade}
        outline={0.03}
      />
      <ToonBox
        size={[D.wallT, WALL_H, D.d]}
        position={[D.x1 - D.wallT / 2, WALL_CY, D.cz]}
        color={PALETTE.storeWallShade}
        outline={0.03}
      />

      {/* 西立面前半段上沿墙带（玻璃上方） */}
      <ToonBox
        size={[D.wallT, upperBandH, 2.1]}
        position={[D.westCX, upperBandCY, -1.85]}
        color={PALETTE.storeWall}
        outline={0.028}
      />
      {/* 西立面后半段：整面实墙 */}
      <ToonBox
        size={[D.wallT, WALL_H, 2.0]}
        position={[D.westCX, WALL_CY, -3.9]}
        color={PALETTE.storeWallShade}
        outline={0.03}
      />
      {/* 西立面后段的员工用门 + 门套，让这面暗墙有内容 */}
      <ToonBox
        size={[0.05, 1.95, 0.85]}
        position={[D.x0 - 0.015, D.floorY + 0.975, -3.65]}
        color={PALETTE.darkMetal}
        outline={0.012}
        castShadow={false}
      />
      <ToonBox
        size={[0.07, 0.08, 0.95]}
        position={[D.x0 - 0.01, D.floorY + 1.99, -3.65]}
        color={PALETTE.metal}
        outline={0.01}
        castShadow={false}
      />
      {[-4.095, -3.205].map((z) => (
        <ToonBox
          key={z}
          size={[0.07, 2.0, 0.06]}
          position={[D.x0 - 0.01, D.floorY + 0.98, z]}
          color={PALETTE.metal}
          outline={0.01}
          castShadow={false}
        />
      ))}
      <ToonBox
        size={[0.06, 0.04, 0.12]}
        position={[D.x0 - 0.05, D.floorY + 1.02, -3.32]}
        color={PALETTE.metal}
        outline={0}
        castShadow={false}
      />
      <ToonBox
        size={[0.08, 0.05, 0.95]}
        position={[D.x0 - 0.02, D.floorY + 0.025, -3.65]}
        color={PALETTE.concrete}
        outline={0}
        castShadow={false}
      />
      {/* 南立面上沿墙带（招牌背墙） */}
      <ToonBox
        size={[D.w, upperBandH, D.wallT]}
        position={[D.cx, upperBandCY, D.southCZ]}
        color={PALETTE.storeWall}
        outline={0.03}
      />

      {/* 橱窗上沿白色横梁（压住玻璃收边） */}
      <ToonBox
        size={[D.w, 0.05, 0.2]}
        position={[D.cx, D.glassTopY + 0.025, D.z1 - 0.07]}
        color={PALETTE.storeTrim}
        outline={0.012}
      />
      <ToonBox
        size={[0.2, 0.05, 2.1]}
        position={[D.x0 + 0.09, D.glassTopY + 0.025, -1.85]}
        color={PALETTE.storeTrim}
        outline={0.012}
      />

      {/* 两个临街转角柱：把玻璃与招牌带收进体块里 */}
      <ToonBox
        size={[0.2, WALL_H, 0.2]}
        position={[D.x0 + 0.1, WALL_CY, D.z1 - 0.1]}
        color={PALETTE.storeWall}
        outline={0.03}
      />
      <ToonBox
        size={[0.2, WALL_H, 0.2]}
        position={[D.x1 - 0.1, WALL_CY, D.z1 - 0.1]}
        color={PALETTE.storeWall}
        outline={0.03}
      />

      {/* 女儿墙下的一道暗色阴影线，让墙顶分层 */}
      <ToonBox
        size={[D.w + 0.01, 0.035, 0.21]}
        position={[D.cx, D.wallTopY - 0.01, D.z1 - 0.1]}
        color={PALETTE.storeWallShade}
        outline={0}
        castShadow={false}
      />

      {/* 屋面 + 女儿墙 */}
      <ToonBox
        size={[D.w - 0.2, 0.06, D.d - 0.2]}
        position={[D.cx, D.wallTopY + 0.03, D.cz]}
        color={PALETTE.roof}
        outline={0}
        castShadow={false}
      />
      {parapets.map((item, index) => (
        <ToonBox
          key={index}
          size={item.size}
          position={item.position}
          color={PALETTE.storeWall}
          outline={0.025}
        />
      ))}

      {/* 室内后墙：品牌色横带 + 深色踢脚，别让玻璃后只剩一片白墙 */}
      <ToonBox
        size={[D.w - 0.3, 0.1, 0.03]}
        position={[D.cx, 2.16, D.z0 + D.wallT + 0.02]}
        color={PALETTE.brand}
        outline={0}
        castShadow={false}
      />
      <ToonBox
        size={[D.w - 0.3, 0.03, 0.03]}
        position={[D.cx, 2.08, D.z0 + D.wallT + 0.02]}
        color={PALETTE.brandAlt}
        outline={0}
        castShadow={false}
      />
      <ToonBox
        size={[D.w - 0.3, 0.12, 0.03]}
        position={[D.cx, 0.3, D.z0 + D.wallT + 0.02]}
        color={PALETTE.darkMetal}
        outline={0}
        castShadow={false}
      />

      {/* 东侧服务面 / 西侧实墙的深色踢脚（外立面） */}
      <ToonBox
        size={[0.05, 0.3, D.d - 0.12]}
        position={[D.x1 - 0.015, D.floorY + 0.15, D.cz]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <ToonBox
        size={[0.05, 0.3, 2.0]}
        position={[D.x0 + 0.015, D.floorY + 0.15, -3.9]}
        color={PALETTE.darkMetal}
        outline={0}
      />

      {/* 西立面后段实墙上的圆形排风口与横向凹槽，破一下大面 */}
      <ToonCylinder
        radiusTop={0.18}
        radiusBottom={0.18}
        height={0.05}
        position={[D.x0 - 0.005, 2.2, -3.75]}
        rotation={[0, 0, Math.PI / 2]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonCylinder
        radiusTop={0.13}
        radiusBottom={0.13}
        height={0.06}
        position={[D.x0 - 0.012, 2.2, -3.75]}
        rotation={[0, 0, Math.PI / 2]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <ToonBox
        size={[0.03, 0.05, 2.0]}
        position={[D.x0 - 0.008, 2.5, -3.9]}
        color={PALETTE.storeWallShade}
        outline={0}
        castShadow={false}
      />

      {/* 北立面（后巷侧）：后门 + 排风格栅 + 纳品口小牌，让背面也有内容 */}
      <ToonBox
        size={[0.9, 1.95, 0.05]}
        position={[2.4, D.floorY + 0.975, D.z0 - 0.02]}
        color={PALETTE.darkMetal}
        outline={0.012}
        castShadow={false}
      />
      <ToonBox
        size={[1.0, 0.08, 0.07]}
        position={[2.4, D.floorY + 1.98, D.z0 - 0.02]}
        color={PALETTE.metal}
        outline={0.01}
        castShadow={false}
      />
      {[1.96, 2.84].map((x) => (
        <ToonBox
          key={x}
          size={[0.06, 2.0, 0.07]}
          position={[x, D.floorY + 0.98, D.z0 - 0.02]}
          color={PALETTE.metal}
          outline={0.01}
          castShadow={false}
        />
      ))}
      <ToonBox
        size={[0.18, 0.34, 0.04]}
        position={[0.55, 2.15, D.z0 - 0.02]}
        color={PALETTE.metal}
        outline={0.01}
        castShadow={false}
      />
      {[2.06, 2.15, 2.24].map((y) => (
        <ToonBox
          key={y}
          size={[0.14, 0.025, 0.03]}
          position={[0.55, y, D.z0 - 0.045]}
          color={PALETTE.darkMetal}
          outline={0}
          castShadow={false}
        />
      ))}
      <NeonPanel
        width={0.42}
        height={0.21}
        map={deliverySign}
        color="#c6c1b2"
        position={[2.4, 2.42, D.z0 - 0.075]}
        rotation={[0, Math.PI, 0]}
      />
    </group>
  );
}
