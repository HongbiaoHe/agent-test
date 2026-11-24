/**
 * 视频轨预览帧的平铺（纯函数，单测见 filmstrip.test.ts）：片段块按「每秒像素」排在时间线上，
 * 块内从左到右铺等宽的格子，每格显示格子中点对应的素材时刻（取拼图里最近的一帧）。
 * 只算落在可视区域（加两侧余量）里的格子：放大后长素材的片段块可能有几十万像素宽。
 */

export interface FilmstripTile {
  /** 格子在片段块内的左边（像素） */
  x: number;
  /** 拼图里的第几帧 */
  frame: number;
}

export function filmstripTiles(opts: {
  /** 片段块在时间线内容里的左边与宽度（像素） */
  blockLeft: number;
  blockWidth: number;
  /** 每格显示宽度（像素） */
  tileWidth: number;
  /** 时间线可视区域（内容坐标） */
  viewLeft: number;
  viewWidth: number;
  pps: number;
  /** 片段在素材里的入点（秒）；图片为 0 */
  inPoint: number;
  /** 拼图：相邻帧的素材时间间隔与帧数 */
  interval: number;
  count: number;
}): FilmstripTile[] {
  const { blockLeft, blockWidth, tileWidth, viewLeft, viewWidth, pps, inPoint, interval, count } = opts;
  if (tileWidth <= 0 || blockWidth <= 0 || count <= 0) return [];
  const total = Math.ceil(blockWidth / tileWidth);
  const first = Math.max(0, Math.floor((viewLeft - blockLeft) / tileWidth) - 2);
  const last = Math.min(total - 1, Math.ceil((viewLeft + viewWidth - blockLeft) / tileWidth) + 2);
  const tiles: FilmstripTile[] = [];
  for (let i = first; i <= last; i++) {
    const x = i * tileWidth;
    const sourceTime = inPoint + Math.min(x + tileWidth / 2, blockWidth) / pps;
    const frame = Math.min(count - 1, Math.max(0, Math.round(sourceTime / interval)));
    tiles.push({ x, frame });
  }
  return tiles;
}
