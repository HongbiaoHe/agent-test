import type { Metadata } from "next";

import { IslandLab } from "./_lab";

export const metadata: Metadata = {
  title: "低多边形悬浮岛 · 3D 场景 | AgentSpark Lab",
  description:
    "程序化建模的低多边形悬浮岛：四套配色、飞鸟盘旋、山羊与奶牛走走停停，全部由 three.js 实时驱动。",
};

export default function IslandPage() {
  return <IslandLab />;
}
