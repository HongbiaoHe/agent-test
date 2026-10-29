"use client";

import dynamic from "next/dynamic";

import type { Palette } from "./_scene/palettes";

/**
 * Three.js / glTF 只在客户端加载：动态引入并关掉 SSR，
 * 这样索引页和首屏都不为 3D 场景买单（见 lab/README 约定 5）。
 */
const SceneStage = dynamic(() => import("./_scene/stage").then((mod) => mod.SceneStage), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-muted" />,
});

type IslandStageProps = {
  palette: Palette;
  wireframe: boolean;
  autoRotate: boolean;
  animals: boolean;
  reducedMotion: boolean;
};

export function IslandStage(props: IslandStageProps) {
  return (
    <div className="absolute inset-0">
      <SceneStage {...props} />
    </div>
  );
}
