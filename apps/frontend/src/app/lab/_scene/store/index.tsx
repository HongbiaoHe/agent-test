"use client";

import { Part } from "../core/assembly";
import { TIMING } from "../core/scene-config";
import { Interior } from "./interior";
import { Rooftop, WallDetails } from "./service";
import { Shell } from "./shell";
import { Awning, Signage } from "./signage";
import { Storefront } from "./storefront";

/**
 * 便利店建筑总装。
 *
 * 时序：结构（TIMING.store）→ 服务面/屋顶 +0.15 → 橱窗玻璃 +0.35 →
 * 招牌 +0.55 → 雨棚 +0.7 → 室内货架（TIMING.interior）。
 * 招牌 / 雨棚灯 / 室内灯板 / 冷柜在 <Power> 里依次通电。
 *
 * Part 会动画它的内层 group，因此所有子构件的坐标都按「装配完成后的绝对位置」写；
 * 外层 group 保持在原点，动画结束后内层回到 identity，位置与设计值完全一致。
 */
export function Store() {
  return (
    <group>
      <Part delay={TIMING.store} distance={1.6} duration={0.9}>
        <Shell />

        <Part delay={TIMING.store + 0.15} distance={1.2} duration={0.8}>
          <WallDetails />
        </Part>

        <Part delay={TIMING.store + 0.28} distance={0.7} duration={0.7}>
          <Rooftop />
        </Part>

        <Part delay={TIMING.store + 0.35} distance={1.2} duration={0.8}>
          <Storefront />
        </Part>

        <Part delay={TIMING.store + 0.55} distance={0.9} duration={0.75}>
          <Signage />
        </Part>

        <Part delay={TIMING.store + 0.7} mode="drop" distance={0.9} duration={0.8}>
          <Awning />
        </Part>

        <Part delay={TIMING.interior} distance={0.9} duration={0.75}>
          <Interior />
        </Part>
      </Part>
    </group>
  );
}
