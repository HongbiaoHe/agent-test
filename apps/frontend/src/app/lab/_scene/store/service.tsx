"use client";

import { useMemo } from "react";

import { NeonPanel, Toon, ToonBox, ToonCylinder, ToonSphere } from "../core/materials";
import { createTextPanelTexture } from "../core/textures";
import { PALETTE, TIMING, type Vec3 } from "../core/scene-config";
import { Power } from "../core/assembly";
import { D } from "./dims";

/**
 * 东侧服务面（面向东侧小巷）与屋顶设备。
 * 服务面：2 台壁挂空调、落水管、电表箱、配管、摄像头、立入禁止小牌。
 * 屋顶：2 台空调外机、排气管、细天线、检修口盖。
 * 注意：props 模块的海报栏占用东墙 z -2.55..-1.45 / y 1.1..2.0，此处避让。
 */

const EAST = D.x1;
const GROUND = D.floorY;

/** 自发光小圆点（摄像头指示灯 / 航空障碍灯），受 <Power> 控制 */
function EmissiveDot({ position, color, radius }: { position: Vec3; color: string; radius: number }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[radius, 8, 6]} />
      <Toon color={color} emissive={color} emissiveIntensity={2.4} />
    </mesh>
  );
}

function EastWallDetails() {
  const notice = useMemo(
    () =>
      createTextPanelTexture({
        width: 256,
        height: 360,
        bg: "#e9e1cf",
        border: "#5c5346",
        borderWidth: 8,
        radius: 6,
        lines: [
          { text: "関係者以外", size: 40, color: "#8f2f2f", weight: 800 },
          { text: "立入禁止", size: 46, color: "#8f2f2f", weight: 800 },
        ],
      }),
    [],
  );

  const acs = [-3.4, -4.4];
  return (
    <group>
      {/* 落水管（前角） */}
      <ToonCylinder
        radiusTop={0.045}
        radiusBottom={0.045}
        height={3.0}
        position={[EAST + 0.075, GROUND + 1.5, -0.82]}
        color={PALETTE.darkMetal}
        outline={0.011}
      />
      {[0.75, 2.35].map((y) => (
        <ToonBox
          key={y}
          size={[0.1, 0.05, 0.13]}
          position={[EAST + 0.03, y, -0.82]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}

      {/* 壁挂空调外机 ×2（避开 props 海报栏） */}
      {acs.map((z) => (
        <group key={z}>
          <ToonBox
            size={[0.2, 0.48, 0.7]}
            position={[EAST + 0.1, 2.02, z]}
            color={PALETTE.storeTrim}
            outline={0.014}
          />
          {[1.92, 2.02, 2.12].map((y) => (
            <ToonBox
              key={y}
              size={[0.02, 0.024, 0.56]}
              position={[EAST + 0.205, y, z]}
              color={PALETTE.darkMetal}
              outline={0}
            />
          ))}
          {/* 冷媒配管 */}
          <ToonCylinder
            radiusTop={0.022}
            radiusBottom={0.022}
            height={0.55}
            position={[EAST + 0.06, 1.62, z + 0.26]}
            color={PALETTE.concrete}
            outline={0}
          />
        </group>
      ))}

      {/* 电表箱 */}
      <ToonBox
        size={[0.14, 0.4, 0.3]}
        position={[EAST + 0.07, 1.5, -2.9]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonBox
        size={[0.03, 0.16, 0.18]}
        position={[EAST + 0.145, 1.56, -2.9]}
        color={PALETTE.darkMetal}
        outline={0}
      />

      {/* 沿墙配管：横向主管 + 竖向支管 */}
      <ToonCylinder
        radiusTop={0.028}
        radiusBottom={0.028}
        height={3.7}
        position={[EAST + 0.055, 2.66, -2.85]}
        rotation={[Math.PI / 2, 0, 0]}
        color={PALETTE.concrete}
        outline={0}
      />
      <ToonCylinder
        radiusTop={0.025}
        radiusBottom={0.025}
        height={1.4}
        position={[EAST + 0.055, 1.98, -1.0]}
        color={PALETTE.concrete}
        outline={0}
      />
      <ToonSphere
        radius={0.045}
        position={[EAST + 0.055, 2.66, -1.0]}
        color={PALETTE.concrete}
        outline={0}
      />

      {/* 监控摄像头（前角，朝向巷口） */}
      <ToonBox
        size={[0.16, 0.06, 0.06]}
        position={[EAST + 0.08, 2.86, -0.98]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />
      <ToonBox
        size={[0.14, 0.16, 0.16]}
        position={[EAST + 0.2, 2.79, -0.98]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonCylinder
        radiusTop={0.045}
        radiusBottom={0.045}
        height={0.05}
        position={[EAST + 0.2, 2.79, -0.88]}
        rotation={[Math.PI / 2, 0, 0]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      <EmissiveDot position={[EAST + 0.2, 2.84, -0.87]} color={PALETTE.neonPink} radius={0.016} />

      {/* 低处通风格栅 */}
      <ToonBox
        size={[0.03, 0.34, 0.5]}
        position={[EAST + 0.005, 0.92, -3.85]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      {[0.82, 0.92, 1.02].map((y) => (
        <ToonBox
          key={y}
          size={[0.02, 0.03, 0.44]}
          position={[EAST + 0.02, y, -3.85]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}

      {/* 立入禁止小牌 */}
      <NeonPanel
        width={0.3}
        height={0.42}
        map={notice}
        color="#c9c3b4"
        position={[EAST + 0.015, 1.42, -4.62]}
        rotation={[0, Math.PI / 2, 0]}
      />
    </group>
  );
}

/** 屋顶设备；航空障碍灯随通电一起亮。 */
export function Rooftop() {
  const roofTop = D.roofTopY;
  return (
    <Power delay={TIMING.power + 1.25} mode="fade">
      <group>
      {/* 空调外机 ×2 */}
      {[
        [2.7, -4.15],
        [0.9, -4.2],
      ].map(([x, z]) => (
        <group key={`${x}-${z}`}>
          <ToonBox
            size={[0.86, 0.06, 0.66]}
            position={[x, roofTop + 0.03, z]}
            color={PALETTE.darkMetal}
            outline={0.01}
          />
          <ToonBox
            size={[0.8, 0.42, 0.6]}
            position={[x, roofTop + 0.27, z]}
            color={PALETTE.storeWallShade}
            outline={0.018}
          />
          <ToonCylinder
            radiusTop={0.27}
            radiusBottom={0.27}
            height={0.04}
            position={[x, roofTop + 0.52, z]}
            color={PALETTE.darkMetal}
            outline={0.01}
          />
        </group>
      ))}

      {/* 排气管 */}
      <ToonCylinder
        radiusTop={0.075}
        radiusBottom={0.075}
        height={0.75}
        position={[3.55, roofTop + 0.375, -3.1]}
        color={PALETTE.metal}
        outline={0.012}
      />
      <ToonCylinder
        radiusTop={0.115}
        radiusBottom={0.115}
        height={0.05}
        position={[3.55, roofTop + 0.775, -3.1]}
        color={PALETTE.darkMetal}
        outline={0.01}
      />

      {/* 细天线 */}
      <ToonCylinder
        radiusTop={0.014}
        radiusBottom={0.018}
        height={1.15}
        position={[-1.3, roofTop + 0.575, -4.4]}
        color={PALETTE.metal}
        outline={0}
      />
      {[0.85, 1.0].map((y) => (
        <ToonBox
          key={y}
          size={[0.34, 0.014, 0.014]}
          position={[-1.3, roofTop + y, -4.4]}
          color={PALETTE.metal}
          outline={0}
        />
      ))}
      <EmissiveDot position={[-1.3, roofTop + 1.16, -4.4]} color="#ff4d6a" radius={0.03} />

      {/* 检修口盖 */}
      <ToonBox
        size={[0.66, 0.12, 0.5]}
        position={[-1.15, roofTop + 0.06, -1.35]}
        color={PALETTE.metal}
        outline={0.014}
      />
      <ToonBox
        size={[0.1, 0.03, 0.04]}
        position={[-1.15, roofTop + 0.135, -1.55]}
        color={PALETTE.darkMetal}
        outline={0}
      />
      </group>
    </Power>
  );
}

/** 东侧服务面：摄像头指示灯随通电亮起。 */
export function WallDetails() {
  return (
    <Power delay={TIMING.power + 1.2} mode="fade">
      <EastWallDetails />
    </Power>
  );
}
