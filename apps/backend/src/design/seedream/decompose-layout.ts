import type { ImageLayer } from '@agent-test/design-schema';

type Box = Pick<ImageLayer, 'x' | 'y' | 'width' | 'height' | 'rotation'>;

/**
 * 拆层子图层 → 画布上的框。
 *
 * bbox 是子图层在**输出底图**坐标系里的 [left, top, right, bottom]；底图与被拆图层同比例，
 * 被拆图层在画布上占 parent 这个框（可能旋转、翻转）。所以先按比例换算到 parent 的未旋转框，
 * 翻转就镜像，再把子框中心绕 parent 中心转 rotation 度（图层都绕自身中心旋转，见 konva-attrs），
 * 子图层沿用同样的旋转角与翻转，叠起来正好还原原图。
 */
export function placeDecomposedChild(
  parent: Box & Pick<ImageLayer, 'flipX' | 'flipY'>,
  base: { width: number; height: number },
  bbox: readonly number[],
): Box {
  const [l, t, r, b] = bbox;
  let fx = l / base.width;
  let fy = t / base.height;
  const fw = Math.max(0, r - l) / base.width;
  const fh = Math.max(0, b - t) / base.height;
  if (parent.flipX) fx = 1 - fx - fw;
  if (parent.flipY) fy = 1 - fy - fh;
  const width = Math.max(1, fw * parent.width);
  const height = Math.max(1, fh * parent.height);
  const cx = parent.x + fx * parent.width + width / 2;
  const cy = parent.y + fy * parent.height + height / 2;
  const pcx = parent.x + parent.width / 2;
  const pcy = parent.y + parent.height / 2;
  const rad = (parent.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = pcx + (cx - pcx) * cos - (cy - pcy) * sin;
  const ry = pcy + (cx - pcx) * sin + (cy - pcy) * cos;
  return {
    x: rx - width / 2,
    y: ry - height / 2,
    width,
    height,
    rotation: parent.rotation,
  };
}

/** absolute 优先（与输出底图同坐标系）；缺了就用 normalized（0–1000）。 */
export function bboxInBase(
  bbox: { absolute?: number[]; normalized?: number[] } | undefined,
  base: { width: number; height: number },
): number[] | null {
  if (bbox?.absolute?.length === 4) return bbox.absolute;
  if (bbox?.normalized?.length === 4) {
    const [l, t, r, b] = bbox.normalized;
    return [
      (l / 1000) * base.width,
      (t / 1000) * base.height,
      (r / 1000) * base.width,
      (b / 1000) * base.height,
    ];
  }
  return null;
}
