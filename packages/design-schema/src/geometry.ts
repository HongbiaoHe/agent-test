/**
 * 生成图与图层框之间的几何换算（后端生成流水线与前端预览共用，保证两边放置结果一致）。
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把 srcW×srcH 的图按 contain 塞进 box：保持 box 中心不动、不变形、不裁切，
 * 返回收紧到图片真实比例后的新框（问题 12：重新生成后版面位置不乱、图不拉伸）。
 */
export function fitContain(box: Box, srcW: number, srcH: number): Box {
  if (srcW <= 0 || srcH <= 0) return box;
  const scale = Math.min(box.width / srcW, box.height / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** 背景图：cover 铺满画布（多出的部分居中裁掉由渲染端按框裁）。 */
export function fitCover(box: Box, srcW: number, srcH: number): Box {
  if (srcW <= 0 || srcH <= 0) return box;
  const scale = Math.max(box.width / srcW, box.height / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * 从模型支持的画幅（目录里写作 `16x9` / `4x5`…）里挑最接近 width/height 比例的一个。
 * 用对数比较：2:1 和 1:2 离 1:1 一样远。
 */
export function closestAspectRatio(
  width: number,
  height: number,
  options: readonly string[],
): string | undefined {
  const target = Math.log(width / height);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const opt of options) {
    const m = /^(\d+(?:\.\d+)?)\s*[x:]\s*(\d+(?:\.\d+)?)$/.exec(opt);
    if (!m) continue;
    const dist = Math.abs(Math.log(Number(m[1]) / Number(m[2])) - target);
    if (dist < bestDist) {
      best = opt;
      bestDist = dist;
    }
  }
  return best;
}
