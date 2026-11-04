import { plainBackgroundPrompt } from '../design-generation.service';
import { bboxInBase, placeDecomposedChild } from './decompose-layout';
import { parseSize, seedreamSize } from './seedream.client';

const MIN = 1280 * 720;
const MAX = Math.floor(2048 * 2048 * 1.1025);

describe('seedreamSize', () => {
  it.each([
    [1080, 1350, '2K'],
    [1920, 1080, '1K'],
    [100, 1600, '1.5K'],
    [5000, 100, '2K'],
  ])('%sx%s @%s 落在官方像素与比例范围内，比例贴近目标', (w, h, res) => {
    const size = parseSize(seedreamSize(w, h, res));
    expect(size).not.toBeNull();
    if (!size) return;
    const px = size.width * size.height;
    expect(px).toBeGreaterThanOrEqual(MIN);
    expect(px).toBeLessThanOrEqual(MAX);
    const ratio = size.width / size.height;
    expect(ratio).toBeGreaterThanOrEqual(1 / 16);
    expect(ratio).toBeLessThanOrEqual(16);
    expect(
      Math.abs(ratio - Math.min(16, Math.max(1 / 16, w / h))),
    ).toBeLessThan(0.05 * ratio);
  });
});

describe('placeDecomposedChild', () => {
  const parent = {
    x: 100,
    y: 200,
    width: 1000,
    height: 500,
    rotation: 0,
    flipX: false,
    flipY: false,
  };
  const base = { width: 2000, height: 1000 };

  it('按底图比例换算回父图层的框', () => {
    expect(placeDecomposedChild(parent, base, [200, 100, 1000, 600])).toEqual({
      x: 200,
      y: 250,
      width: 400,
      height: 250,
      rotation: 0,
    });
  });

  it('父图层水平翻转时镜像位置', () => {
    const box = placeDecomposedChild(
      { ...parent, flipX: true },
      base,
      [0, 0, 400, 1000],
    );
    expect(box.x).toBeCloseTo(900);
    expect(box.width).toBeCloseTo(200);
  });

  it('父图层旋转时子框中心绕父中心转，子图层沿用旋转角', () => {
    // 子框在父框右半边正中；父转 90° 后子框中心应落到父中心正下方
    const box = placeDecomposedChild(
      { ...parent, rotation: 90 },
      base,
      [1000, 0, 2000, 1000],
    );
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    expect(cx).toBeCloseTo(600);
    expect(cy).toBeCloseTo(450 + 250);
    expect(box.rotation).toBe(90);
  });
});

describe('bboxInBase', () => {
  it('absolute 优先，否则把 0–1000 的 normalized 换算到底图像素', () => {
    expect(
      bboxInBase(
        { absolute: [1, 2, 3, 4], normalized: [0, 0, 0, 0] },
        { width: 10, height: 10 },
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(
      bboxInBase(
        { normalized: [187, 59, 808, 188] },
        { width: 2048, height: 2048 },
      )?.[0],
    ).toBeCloseTo(383, 0);
    expect(bboxInBase(undefined, { width: 1, height: 1 })).toBeNull();
  });
});

describe('plainBackgroundPrompt', () => {
  it('把透明背景的说法换成纯色底（文生图没有透明模式）', () => {
    const p = plainBackgroundPrompt(
      'isolated red sneaker, on a transparent background, no text',
    );
    expect(p).not.toMatch(/transparent/i);
    expect(p).toMatch(/plain solid/);
  });
  it('没提背景的补一句纯色底', () => {
    expect(plainBackgroundPrompt('a golden trophy')).toMatch(
      /plain solid light gray background/,
    );
  });
});
