import type { Metadata } from "next";

import { RainyStoreStage } from "./_stage";

export const metadata: Metadata = {
  title: "雨夜便利店街角 · 微缩场景 | AgentSpark Lab",
  description:
    "日式便利店街角微缩模型：三渲二夜景、自由旋转缩放、从地面组装入场。",
};

export default function RainyStorePage() {
  return <RainyStoreStage />;
}
