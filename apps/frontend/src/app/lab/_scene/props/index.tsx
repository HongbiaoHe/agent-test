"use client";

import { Part } from "../core/assembly";
import {
  ANCHOR,
  SIDEWALK,
  TIMING,
  type Vec3,
} from "../core/scene-config";
import { Bicycle } from "./bicycle";
import { Cat } from "./cat";
import { BeerCrateStack, CardboardBox, PottedPlant, TrafficCone } from "./clutter";
import { AFrameBoard, RecycleBin, UmbrellaStand } from "./fittings";
import { NoticeBoard } from "./notice-board";
import { VendingGroundGlow, VendingMachine } from "./vending";

/**
 * 街角生活物件总装。
 *
 * 摆放约定：
 * - 人行道顶面 y=0.18；但对落在 Lead 铺的湿反射面（前场 z>-0.6）里的物件，
 *   抬到 y=0.19（ART-SPEC §2：湿面不挡光，不要在 y<0.19 放东西）。
 * - 每个物件各自一个 <Part>，从 TIMING.props 开始按 0.08~0.2s 错开出场。
 * - 贩卖机 / 猫的氛围光晕在组件内部包 <Power>，随电源一起闪亮。
 */

const GROUND = SIDEWALK.topY;
const WET_GROUND = SIDEWALK.topY + 0.01;

/** 前场（湿反射面）上的物件用 WET_GROUND，其余用 GROUND */
function at(x: number, z: number, y: number = WET_GROUND): Vec3 {
  return [x, y, z];
}

const delay = (offset: number) => TIMING.props + offset;

const BIN_X = [
  ANCHOR.bins.x - 0.37,
  ANCHOR.bins.x,
  ANCHOR.bins.x + 0.37,
] as const;

/** 自行车为了避开 A 字牌，比 ANCHOR 略向北挪了 12cm */
const BIKE_POSITION = at(ANCHOR.bike.x + 0.05, ANCHOR.bike.z + 0.12);
const BIKE_ROTATION = -1.25;

/**
 * 贩卖机贴墙摆，但把整排再向西南转 18°：默认机位在西南方，正面朝正西时
 * 两台机器会前后叠死、只剩白色侧板。这个角度既保持“朝西侧路口”，又能让
 * 冷饮/热饮灯箱在默认机位里读得出来。位置同时西移 10cm 给转动留出墙距。
 */
const VENDING_SWING = 0.32;
const VENDING_X = -2.34;

/** 猫从锚点向南挪了约 15cm、20cm，避开电线杆的遮挡（锚点正好在杆子背光面） */
const CAT_POSITION = at(ANCHOR.cat.x + 0.15, ANCHOR.cat.z + 0.2, GROUND);

export function Props() {
  const [vendCool, vendWarm] = ANCHOR.vending;

  return (
    <group>
      {/* —— 贩卖机（第二视觉焦点） —— */}
      <Part delay={delay(0)} duration={0.9} mode="rise" distance={1.4}>
        <VendingMachine
          variant="cool"
          position={at(VENDING_X, vendCool.z, GROUND)}
          rotationY={vendCool.ry + VENDING_SWING}
        />
      </Part>
      <Part delay={delay(0.1)} duration={0.9} mode="rise" distance={1.4}>
        <VendingMachine
          variant="warm"
          position={at(VENDING_X, vendWarm.z, GROUND)}
          rotationY={vendWarm.ry + VENDING_SWING}
        />
      </Part>
      <VendingGroundGlow />

      {/* —— 猫：贩卖机旁，尾巴自己摆 —— */}
      <Part delay={delay(0.18)} duration={0.6} mode="pop">
        <Cat position={CAT_POSITION} rotationY={-0.75} />
      </Part>

      {/* —— 自行车 —— */}
      <Part delay={delay(0.28)} duration={0.9} mode="pop">
        <Bicycle position={BIKE_POSITION} rotationY={BIKE_ROTATION} />
      </Part>

      {/* —— 三只回收桶 —— */}
      <Part delay={delay(0.38)} duration={0.6} mode="rise" distance={0.6}>
        <RecycleBin kind="can" position={at(BIN_X[0], ANCHOR.bins.z)} />
      </Part>
      <Part delay={delay(0.46)} duration={0.6} mode="rise" distance={0.6}>
        <RecycleBin kind="bottle" position={at(BIN_X[1], ANCHOR.bins.z)} />
      </Part>
      <Part delay={delay(0.54)} duration={0.6} mode="rise" distance={0.6}>
        <RecycleBin kind="pet" position={at(BIN_X[2], ANCHOR.bins.z)} />
      </Part>

      {/* —— 伞架 —— */}
      <Part delay={delay(0.62)} duration={0.7} mode="rise" distance={0.8}>
        <UmbrellaStand position={at(ANCHOR.umbrella.x, ANCHOR.umbrella.z)} />
      </Part>

      {/* —— A 字告示牌 —— */}
      <Part delay={delay(0.7)} duration={0.7} mode="pop">
        <AFrameBoard
          position={at(ANCHOR.aBoard.x, ANCHOR.aBoard.z)}
          rotationY={ANCHOR.aBoard.ry}
        />
      </Part>

      {/* —— 小巷墙上的公告栏（挂在 store 墙上，注意别共面） —— */}
      <Part delay={delay(0.78)} duration={0.7} mode="pop">
        <NoticeBoard
          position={[
            ANCHOR.noticeBoard.x + 0.015,
            ANCHOR.noticeBoard.y,
            ANCHOR.noticeBoard.z,
          ]}
          rotationY={Math.PI / 2}
        />
      </Part>

      {/* —— 巷口杂物 —— */}
      <Part delay={delay(0.86)} duration={0.65} mode="pop">
        <BeerCrateStack position={at(5.34, -0.35)} rotationY={0.22} />
      </Part>
      <Part
        delay={delay(0.94)}
        duration={0.6}
        mode="drop"
        distance={0.5}
        position={at(5.36, -0.35, WET_GROUND + 0.487)}
        rotation={[0, 0.5, 0]}
      >
        <CardboardBox position={[0, 0, 0]} rotationY={0} />
      </Part>

      {/* —— 门口两盆绿植 —— */}
      <Part delay={delay(1.0)} duration={0.6} mode="pop">
        <PottedPlant position={at(4.6, -0.15)} variant="a" />
      </Part>
      <Part delay={delay(1.06)} duration={0.6} mode="pop">
        <PottedPlant position={at(5.72, -0.22)} variant="b" />
      </Part>

      {/* —— 停车位旁的橙色锥桶 —— */}
      <Part delay={delay(1.12)} duration={0.6} mode="pop">
        <TrafficCone position={at(3.9, 2.13)} rotationY={0.4} />
      </Part>
    </group>
  );
}
