"use client";

import dynamic from "next/dynamic";

import { PALETTE } from "../_scene/core/scene-config";

/**
 * 3D 场景只存在于客户端：动态加载，关掉 SSR。
 * 加载期间用场景底色占位，避免白屏闪烁（本页没有任何 UI，只有模型）。
 */
const Stage = dynamic(
  () => import("../_scene/core/stage").then((mod) => mod.Stage),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-full w-full"
        style={{ background: PALETTE.background }}
      />
    ),
  },
);

export function RainyStoreStage() {
  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      <Stage />
    </div>
  );
}
