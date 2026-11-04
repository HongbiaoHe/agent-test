"use client";

import { useEffect, useState } from "react";

import { loadImage } from "../../_lib/render";

/** 按 src 加载图片（crossOrigin，导出不被污染）；src 变化时保留上一张，新图到了再换，不闪空白。 */
export function useLoadedImage(src: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ src: string; img: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    loadImage(src)
      .then((img) => {
        if (alive) setLoaded({ src, img });
      })
      .catch(() => {
        // 加载失败保持旧图；图层面板会显示无图
      });
    return () => {
      alive = false;
    };
  }, [src]);
  return src ? (loaded?.img ?? null) : null;
}
