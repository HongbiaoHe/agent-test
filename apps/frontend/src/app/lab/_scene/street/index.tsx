"use client";

import { Part, Power } from "../core/assembly";
import { TIMING } from "../core/scene-config";

import { AlleyEntrance } from "./alley";
import {
  CrossingSign,
  PipeGuardrail,
  RearBoundary,
  TrafficMirror,
} from "./furniture";
import { Markings, Paving, Puddles } from "./ground";
import { StreetLamp } from "./lamp";
import { UtilityPole } from "./utility-pole";

/**
 * street 模块总装。
 *
 * 动画时序（ART-SPEC §3B.5）：
 * - 地面铺装 / 标线 / 积水从 TIMING.ground 起分层升起；
 * - 街道设施从 TIMING.fixtures 起每件 +0.12s 依次入场；
 * - 路灯与两只纸灯笼的发光体包在 <Power> 里，随 TIMING.power 通电闪烁。
 */
export function Street() {
  return (
    <group>
      {/* 地面：人行道 + 路缘 + 排水沟 + 井盖 */}
      <Part delay={TIMING.ground} duration={0.9} distance={1.2}>
        <Paving />
      </Part>

      {/* 马路标线 + 停车位 */}
      <Part delay={TIMING.ground + 0.2} duration={0.8} distance={0.7}>
        <Markings />
      </Part>

      {/* 积水 */}
      <Part delay={TIMING.ground + 0.32} duration={0.8} distance={0.5}>
        <Puddles />
      </Part>

      {/* 路灯（发光体通电） */}
      <Part delay={TIMING.fixtures} duration={0.9} distance={1.6}>
        <Power delay={TIMING.power + 0.25}>
          <StreetLamp />
        </Power>
      </Part>

      {/* 电线杆 + 电线 */}
      <Part delay={TIMING.fixtures + 0.12} duration={1} distance={2.2}>
        <UtilityPole />
      </Part>

      {/* 街角凸面镜 */}
      <Part delay={TIMING.fixtures + 0.24} duration={0.85} distance={1.2}>
        <TrafficMirror />
      </Part>

      {/* 行人过街标志 */}
      <Part delay={TIMING.fixtures + 0.36} duration={0.85} distance={1.2}>
        <CrossingSign />
      </Part>

      {/* 南侧人行道护栏：缩成西南转角的一小段，避免横切店前 */}
      <Part delay={TIMING.fixtures + 0.48} duration={0.8} distance={1}>
        <PipeGuardrail axis="x" fixed={2.62} from={-3.25} to={-2.35} />
      </Part>

      {/* 西侧人行道护栏（让开西侧斑马线） */}
      <Part delay={TIMING.fixtures + 0.6} duration={0.8} distance={1}>
        <PipeGuardrail axis="z" fixed={-3.5} from={-2.6} to={0.1} />
      </Part>

      {/* 小巷入口（暖帘 + 灯笼通电） */}
      <Part delay={TIMING.fixtures + 0.72} duration={0.95} distance={1.4}>
        <Power delay={TIMING.power + 1.05}>
          <AlleyEntrance />
        </Power>
      </Part>

      {/* 后巷低墙 */}
      <Part delay={TIMING.fixtures + 0.84} duration={0.9} distance={1.2}>
        <RearBoundary />
      </Part>
    </group>
  );
}
