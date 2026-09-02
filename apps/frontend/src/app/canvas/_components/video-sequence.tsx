"use client";

import { Play } from "lucide-react";
import { useState } from "react";

import { useMediaAsset } from "../_hooks/use-media-asset";

/**
 * 多段视频的连续预览：把上游各段按顺序**接着播**，不必等真的合成。
 *
 * 只挂**一个** <video>，播完一段换下一段的 src——而不是把 N 段都渲出来。
 * 段数随连线变化，逐段调 useMediaAsset 会违反 hooks 规则（数量必须固定）；
 * 单个播放器只按"当前这段"取资产，顺带也省了同时拉 N 份 blob 的带宽。
 *
 * 悬停才播、移开归零：画布上可能同时摆着十几张卡，全都自动循环播放会吵得没法看，
 * 而点击已经是"选中并打开面板"了（见 canvas-nodes）。
 */
export function VideoSequence({ clips }: { clips: string[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const asset = useMediaAsset(clips[index] ?? null);

  return (
    <div
      className="relative"
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => {
        setPlaying(false);
        setIndex(0);
      }}
    >
      {asset.status === "ready" ? (
        <video
          // key 带上段序号：换段时重建元素，autoPlay 才会对新的 src 再触发一次
          key={index}
          src={asset.url}
          muted
          playsInline
          autoPlay={playing}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) {
              v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
            }
          }}
          // 播完接下一段；最后一段播完回到第一段，停在首帧等下一次悬停
          onEnded={() => setIndex((i) => (i + 1 < clips.length ? i + 1 : 0))}
          className="pointer-events-none block h-auto w-full"
        />
      ) : (
        <div className="flex h-24 items-center justify-center bg-muted" />
      )}

      {/* 角标：这是第几段 / 共几段。不悬停时兼作「有 N 段可连着看」的提示 */}
      <span className="pointer-events-none absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded-full bg-foreground/75 px-1.5 py-0.5 font-mono text-[10px] text-background">
        {!playing && <Play className="size-2.5 fill-current" aria-hidden />}
        {playing ? `${index + 1}/${clips.length}` : clips.length}
      </span>
    </div>
  );
}
