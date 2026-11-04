import { nearestFontWeight } from './fonts';
import type { ImageLayer, TextLayer } from './layer';

/**
 * 图层 → Konva 节点属性的**唯一映射**（前端 react-konva 画板、后端 skia 渲染器、导出共用）。
 * 同构渲染（问题 8）的前提是两边喂给 Konva 的是同一份属性，所以映射只写在这里。
 * 只产出纯数据，不依赖 konva 包本身。
 *
 * 旋转与翻转都绕图层中心：x/y 指向中心、offset 取半宽半高。
 */

/** #RRGGBBAA → rgba()（Konva 的颜色解析对 8 位 hex 支持不稳，统一转掉）。 */
export function cssColor(hex: string): string {
  if (hex.length !== 9) return hex;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${(n(7) / 255).toFixed(3)})`;
}

function centered(layer: { x: number; y: number; width: number; height: number; rotation: number; opacity: number; visible: boolean }) {
  return {
    x: layer.x + layer.width / 2,
    y: layer.y + layer.height / 2,
    offsetX: layer.width / 2,
    offsetY: layer.height / 2,
    rotation: layer.rotation,
    opacity: layer.opacity,
    visible: layer.visible,
  };
}

export function imageKonvaAttrs(layer: ImageLayer) {
  return {
    ...centered(layer),
    width: layer.width,
    height: layer.height,
    scaleX: layer.flipX ? -1 : 1,
    scaleY: layer.flipY ? -1 : 1,
  };
}

/** Konva 的 fontStyle 同时承载斜体与字重（如 "italic 700"），字重取该字体真实有的那档。 */
export function konvaFontStyle(layer: Pick<TextLayer, 'fontFamily' | 'fontWeight' | 'fontStyle'>): string {
  const weight = nearestFontWeight(layer.fontFamily, layer.fontWeight);
  return `${layer.fontStyle === 'italic' ? 'italic ' : ''}${weight}`;
}

/** 字体族名加引号：带空格的族名（Noto Sans SC）在 canvas font 串里必须引起来。 */
export function konvaFontFamily(family: string): string {
  return `"${family}"`;
}

export function displayText(layer: Pick<TextLayer, 'text' | 'textTransform'>): string {
  return layer.textTransform === 'uppercase' ? layer.text.toUpperCase() : layer.text;
}

/**
 * 文字：宽度固定、自动换行；**不传 height**，让 Konva 按内容量出高度（再回写进图层）。
 * offsetY 用图层里记的 height——它是上一次量出来的值，旋转中心才稳定。
 */
export function textKonvaAttrs(layer: TextLayer) {
  return {
    ...centered(layer),
    width: layer.width,
    text: displayText(layer),
    fontFamily: konvaFontFamily(layer.fontFamily),
    fontSize: layer.fontSize,
    fontStyle: konvaFontStyle(layer),
    fill: cssColor(layer.fill),
    align: layer.align,
    lineHeight: layer.lineHeight,
    letterSpacing: layer.letterSpacing,
    textDecoration: layer.textDecoration === 'none' ? '' : layer.textDecoration,
    wrap: 'word',
    ...(layer.stroke && layer.stroke.width > 0
      ? {
          stroke: cssColor(layer.stroke.color),
          strokeWidth: layer.stroke.width,
          // 描边画在填充下面：粗描边不吃掉字形
          fillAfterStrokeEnabled: true,
        }
      : { strokeWidth: 0 }),
    ...(layer.shadow
      ? {
          shadowColor: cssColor(layer.shadow.color),
          shadowBlur: layer.shadow.blur,
          shadowOffsetX: layer.shadow.offsetX,
          shadowOffsetY: layer.shadow.offsetY,
          shadowOpacity: 1,
          shadowEnabled: true,
        }
      : { shadowEnabled: false }),
  };
}
