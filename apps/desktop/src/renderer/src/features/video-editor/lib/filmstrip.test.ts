import { describe, expect, it } from 'vitest';
import { filmstripTiles } from './filmstrip';

const base = {
  blockLeft: 0,
  blockWidth: 400,
  tileWidth: 80,
  viewLeft: 0,
  viewWidth: 1000,
  pps: 100,
  inPoint: 0,
  interval: 0.5,
  count: 20,
};

describe('filmstripTiles', () => {
  it('每格取中点对应的素材时刻：100 px/s、格宽 80 → 0.4s、1.2s、2.0s… 的帧', () => {
    expect(filmstripTiles(base)).toEqual([
      { x: 0, frame: 1 },
      { x: 80, frame: 2 },
      { x: 160, frame: 4 },
      { x: 240, frame: 6 },
      { x: 320, frame: 7 },
    ]);
  });

  it('入点偏移：素材从 3 秒开始截，第一格是 3.4 秒的帧；超出素材的取最后一帧', () => {
    expect(filmstripTiles({ ...base, inPoint: 3 })[0].frame).toBe(7);
    expect(filmstripTiles({ ...base, inPoint: 30 }).every((t) => t.frame === 19)).toBe(true);
  });

  it('只算可视区域附近的格子（两侧各多两格）', () => {
    const tiles = filmstripTiles({ ...base, blockWidth: 100_000, viewLeft: 50_000, viewWidth: 800 });
    expect(tiles).toHaveLength(15);
    expect(tiles[0].x).toBe(49_840);
    // 片段块在可视区域之外：一格都不算
    expect(filmstripTiles({ ...base, blockLeft: 5_000 })).toEqual([]);
  });
});
