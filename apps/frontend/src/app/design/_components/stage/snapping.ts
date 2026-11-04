import type { DesignDocument } from "@agent-test/design-schema";

/**
 * 拖动吸附：被拖图层的左/中/右、上/中/下 6 条线，贴近画布边缘与中线、其它图层的边与中线时吸过去。
 * 全部在设计稿坐标里算；阈值按屏幕像素换算（缩小视图时更容易吸上）。
 */

export interface Guide {
  orientation: "v" | "h";
  /** 设计稿坐标 */
  pos: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function lines(box: Box) {
  return {
    v: [box.x, box.x + box.width / 2, box.x + box.width],
    h: [box.y, box.y + box.height / 2, box.y + box.height],
  };
}

export function snapBox(
  doc: DesignDocument,
  moving: Box,
  excludeIds: string[],
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const targetsV = [0, doc.canvas.width / 2, doc.canvas.width];
  const targetsH = [0, doc.canvas.height / 2, doc.canvas.height];
  for (const l of doc.layers) {
    if (excludeIds.includes(l.id) || !l.visible) continue;
    const t = lines(l);
    targetsV.push(...t.v);
    targetsH.push(...t.h);
  }
  const own = lines(moving);
  const best = (mine: number[], targets: number[]) => {
    let delta = 0;
    let pos: number | null = null;
    let dist = threshold;
    for (const m of mine) {
      for (const t of targets) {
        const d = Math.abs(t - m);
        if (d < dist) {
          dist = d;
          delta = t - m;
          pos = t;
        }
      }
    }
    return { delta, pos };
  };
  const v = best(own.v, targetsV);
  const h = best(own.h, targetsH);
  const guides: Guide[] = [];
  if (v.pos !== null) guides.push({ orientation: "v", pos: v.pos });
  if (h.pos !== null) guides.push({ orientation: "h", pos: h.pos });
  return { dx: v.delta, dy: h.delta, guides };
}
