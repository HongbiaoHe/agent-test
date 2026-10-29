"use client";

import { useMemo } from "react";

import { Toon, ToonBox, ToonSphere } from "../core/materials";
import { PALETTE, type Vec3 } from "../core/scene-config";
import {
  createPosterTexture,
  createTextPanelTexture,
  mixHex,
} from "../core/textures";

/**
 * 东侧小巷实墙上的木质公告栏（ANCHOR.noticeBoard，挂在 x=4.2 的墙面上，朝 +x）。
 * 本地坐标：内容朝 +z；摆放时整体绕 y 旋转 +π/2 → 内容朝 +x。
 * 原点贴在墙面（本地 z=0），所有构件向 +z 外挑，避免和 store 的墙共面。
 */

const CORK = mixHex(PALETTE.woodLight, PALETTE.cream, 0.52);
const FRAME = PALETTE.wood;

const POSTERS = [
  {
    title: "防災訓練",
    subtitle: "9月1日 10:00",
    accent: PALETTE.brand,
    badge: "町内会",
    bg: "#f1e8d8",
    x: -0.3,
    y: -0.02,
    tilt: 0.05,
  },
  {
    title: "スタッフ募集",
    subtitle: "ひかりマート",
    accent: PALETTE.brandAlt,
    badge: "急募",
    bg: "#f4ecd9",
    x: 0.02,
    y: 0.0,
    tilt: -0.04,
  },
  {
    title: "秋祭り",
    subtitle: "桜町 2丁目",
    accent: PALETTE.neonPink,
    badge: "10/14",
    bg: "#efe6e0",
    x: 0.32,
    y: -0.03,
    tilt: 0.06,
  },
] as const;

export function NoticeBoard({
  position,
  rotationY,
}: {
  position: Vec3;
  rotationY: number;
}) {
  const header = useMemo(
    () =>
      createTextPanelTexture({
        width: 512,
        height: 96,
        bg: "#f4ecd9",
        border: FRAME,
        borderWidth: 5,
        lines: [{ text: "お知らせ", size: 52, color: "#2b2620" }],
      }),
    [],
  );
  const posters = useMemo(
    () =>
      POSTERS.map((poster) =>
        createPosterTexture({
          title: poster.title,
          subtitle: poster.subtitle,
          accent: poster.accent,
          badge: poster.badge,
          bg: poster.bg,
        }),
      ),
    [],
  );

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* 软木板背板 */}
      <ToonBox
        size={[0.96, 0.68, 0.03]}
        position={[0, 0, 0.017]}
        color={CORK}
        outline={0.01}
      />
      {/* 木框 */}
      <ToonBox size={[1.06, 0.055, 0.06]} position={[0, 0.3625, 0.03]} color={FRAME} outline={0.01} />
      <ToonBox size={[1.06, 0.055, 0.06]} position={[0, -0.3625, 0.03]} color={FRAME} outline={0.01} />
      <ToonBox size={[0.055, 0.78, 0.06]} position={[-0.5025, 0, 0.03]} color={FRAME} outline={0.01} />
      <ToonBox size={[0.055, 0.78, 0.06]} position={[0.5025, 0, 0.03]} color={FRAME} outline={0.01} />

      {/* 标题条 */}
      <ToonBox size={[0.82, 0.12, 0.012]} position={[0, 0.255, 0.045]} color={PALETTE.cream} outline={0} />
      <mesh position={[0, 0.255, 0.054]}>
        <planeGeometry args={[0.8, 0.1]} />
        <Toon color="#ffffff" map={header} emissive={PALETTE.cream} emissiveIntensity={0.22} />
      </mesh>

      {/* 三张海报 */}
      {POSTERS.map((poster, index) => (
        <group
          key={poster.title}
          position={[poster.x, poster.y, 0.042]}
          rotation={[0, 0, poster.tilt]}
        >
          <mesh>
            <planeGeometry args={[0.23, 0.31]} />
            <Toon
              color="#ffffff"
              map={posters[index]}
              emissive={PALETTE.cream}
              emissiveIntensity={0.12}
            />
          </mesh>
          {/* 图钉 */}
          <ToonSphere radius={0.0085} position={[-0.085, 0.132, 0.006]} color={PALETTE.neonPink} outline={0} segments={8} />
          <ToonSphere radius={0.0085} position={[0.085, 0.132, 0.006]} color={PALETTE.brandAlt} outline={0} segments={8} />
        </group>
      ))}

      {/* 底部挂墙支架 */}
      <ToonBox size={[0.06, 0.12, 0.08]} position={[-0.3, -0.42, 0.035]} color={PALETTE.metal} outline={0.006} />
      <ToonBox size={[0.06, 0.12, 0.08]} position={[0.3, -0.42, 0.035]} color={PALETTE.metal} outline={0.006} />
    </group>
  );
}
