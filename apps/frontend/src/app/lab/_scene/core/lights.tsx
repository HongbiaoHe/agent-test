"use client";

import { Power } from "./assembly";
import { PALETTE, TIMING } from "./scene-config";

/**
 * 夜景灯光总控。
 *
 * 冷色月光负责整体塑形（三渲二的明暗色阶靠它），暖色全部是场景内的光源：
 * 便利店室内、门头、招牌柱、贩卖机、路灯、小巷灯笼。
 * 通电后各光源按 delay 依次亮起，制造「一家店开门营业」的感觉。
 */
export function Lights() {
  return (
    <>
      {/* 夜色环境光：保证暗部不是死黑，同时保持冷调 */}
      <ambientLight intensity={1.05} color={PALETTE.ambient} />
      <hemisphereLight args={["#46527c", "#080a10", 0.75]} />

      {/* 月光：主光，唯一投影光源 */}
      <directionalLight
        position={[-9, 13, 9]}
        intensity={1.4}
        color={PALETTE.moon}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-bias={-0.0006}
        shadow-normalBias={0.02}
      />
      {/* 右侧极弱的补光，别让背光面完全糊掉 */}
      <directionalLight
        position={[8, 5, -6]}
        intensity={0.35}
        color="#6f7fb8"
      />

      {/* 便利店室内：两组暖光，透过玻璃洒到人行道 */}
      <Power delay={TIMING.power + 0.15} mode="fade">
        <pointLight
          position={[0.9, 2.15, -2.5]}
          intensity={5}
          distance={8}
          decay={2}
          color={PALETTE.interior}
        />
        <pointLight
          position={[3.1, 2.15, -2.7]}
          intensity={3.5}
          distance={7}
          decay={2}
          color={PALETTE.interior}
        />
        <pointLight
          position={[0.25, 1.75, 0.95]}
          intensity={3.5}
          distance={5.5}
          decay={2}
          color={PALETTE.warmLight}
        /></Power>

      {/* 门头招牌的冷白洗墙光 */}
      <Power delay={TIMING.power + 0.6}>
        <pointLight
          position={[0.75, 2.85, 0.15]}
          intensity={2.6}
          distance={4.5}
          decay={2}
          color="#ffeccd"
        /></Power>

      {/* 贩卖机：青白色冷光，是街角重要的第二光源 */}
      <Power delay={TIMING.power + 0.4}>
        <pointLight
          position={[-2.65, 1.35, -2.1]}
          intensity={3.2}
          distance={4.2}
          decay={2}
          color={PALETTE.neonCyan}
        /></Power>

      {/* 立柱灯箱 */}
      <Power delay={TIMING.power + 0.85}>
        <pointLight
          position={[-2.72, 3.2, 1.32]}
          intensity={4}
          distance={6}
          decay={2}
          color="#eaf6ff"
        /></Power>

      {/* 街角路灯（暖钠灯） */}
      <Power delay={TIMING.power + 0.25}>
        <spotLight
          position={[3.35, 4.15, 2.3]}
          intensity={16}
          distance={13}
          angle={0.78}
          penumbra={0.65}
          decay={1.8}
          color={PALETTE.lampWarm}
        /></Power>

      {/* 小巷入口的灯笼 */}
      <Power delay={TIMING.power + 1.05}>
        <pointLight
          position={[4.5, 2.05, -1.25]}
          intensity={2.4}
          distance={3.2}
          decay={2}
          color={PALETTE.neonPink}
        /></Power>

      {/* 霓虹氛围补光：让店右侧的阴影里有一点紫调 */}
      <Power delay={TIMING.power + 1.2} mode="fade">
        <pointLight
          position={[4.6, 1.1, 0.6]}
          intensity={1.8}
          distance={4}
          decay={2}
          color={PALETTE.neonViolet}
        /></Power>
    </>
  );
}
