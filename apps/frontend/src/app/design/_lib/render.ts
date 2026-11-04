"use client";

import {
  cssColor,
  type DesignDocument,
  imageKonvaAttrs,
  type Layer,
  nearestFontWeight,
  textKonvaAttrs,
} from "@agent-test/design-schema";
import type { Layer as PsdLayer } from "ag-psd";
import Konva from "konva";

import { loadDocumentFonts } from "./fonts";

/**
 * 离屏渲染（导出用）：用与画板、后端同一份 konva-attrs 映射，在一个不挂到页面上的 Stage 里
 * 把文档原尺寸画出来——不受当前缩放、选中框、参考线影响，所见即所得（问题 13）。
 * 图片走 crossOrigin=anonymous（CDN 回 access-control-allow-origin: *），否则画布被污染导不出。
 */

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(src);
        reject(new Error(`图片加载失败：${src}`));
      };
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

async function buildNode(layer: Layer): Promise<Konva.Shape | null> {
  if (layer.type === "text") return new Konva.Text(textKonvaAttrs(layer));
  if (!layer.src) return null;
  const image = await loadImage(layer.src);
  return new Konva.Image({ ...imageKonvaAttrs(layer), image });
}

interface StageHandle {
  stage: Konva.Stage;
  nodes: Map<string, Konva.Shape>;
  destroy: () => void;
}

async function buildStage(
  doc: DesignDocument,
  opts: { background: boolean; only?: string },
): Promise<StageHandle> {
  await loadDocumentFonts(doc);
  const container = document.createElement("div");
  const { width, height } = doc.canvas;
  const stage = new Konva.Stage({ container, width, height });
  const layer = new Konva.Layer();
  stage.add(layer);
  if (opts.background && doc.canvas.background !== "transparent") {
    layer.add(new Konva.Rect({ width, height, fill: cssColor(doc.canvas.background) }));
  }
  const nodes = new Map<string, Konva.Shape>();
  for (const l of doc.layers) {
    if (opts.only && l.id !== opts.only) continue;
    if (!opts.only && !l.visible) continue;
    const node = await buildNode(l);
    if (!node) continue;
    // 单层导出时即便图层被隐藏也要画出来
    node.visible(true);
    layer.add(node);
    nodes.set(l.id, node);
  }
  layer.draw();
  return { stage, nodes, destroy: () => stage.destroy() };
}

export type RasterFormat = "png" | "jpeg" | "webp";

/** 整张成品图。JPG 没有透明通道：透明区域填画布底色（透明底则填白）。 */
export async function exportRaster(
  doc: DesignDocument,
  format: RasterFormat,
  pixelRatio: number,
  quality = 0.92,
): Promise<Blob> {
  const h = await buildStage(doc, { background: true });
  try {
    const canvas = h.stage.toCanvas({ pixelRatio });
    let out = canvas;
    if (format === "jpeg") {
      out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("浏览器不支持 canvas 2D");
      ctx.fillStyle =
        doc.canvas.background === "transparent" ? "#FFFFFF" : cssColor(doc.canvas.background);
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(canvas, 0, 0);
    }
    return await canvasToBlob(out, `image/${format}`, quality);
  } finally {
    h.destroy();
  }
}

/** 单个图层的透明 PNG：裁到该图层（含旋转后）的外接框。 */
export async function exportLayerPng(
  doc: DesignDocument,
  layerId: string,
  pixelRatio = 2,
): Promise<Blob> {
  const h = await buildStage(doc, { background: false, only: layerId });
  try {
    const node = h.nodes.get(layerId);
    if (!node) throw new Error("这个图层没有可导出的内容");
    const rect = node.getClientRect();
    const canvas = h.stage.toCanvas({ ...rect, pixelRatio });
    return await canvasToBlob(canvas, "image/png");
  } finally {
    h.destroy();
  }
}

/** 最大边不超过浏览器 canvas 上限时才允许该倍率（导出菜单据此置灰）。 */
export const MAX_CANVAS_SIDE = 16384;

export function canExportAt(doc: DesignDocument, ratio: number): boolean {
  return Math.max(doc.canvas.width, doc.canvas.height) * ratio <= MAX_CANVAS_SIDE;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出失败"))),
      type,
      quality,
    );
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ——— PSD（问题 14：文字写成可编辑文字图层 + 附预渲染像素）———

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** Photoshop 认 PostScript 名（如 NotoSansSC-Bold）；没装这款字体时 PS 会提示缺字并替换。 */
function postScriptName(family: string, weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[nearestFontWeight(family, weight)] ?? "Regular";
  const style = italic ? (w === "Regular" ? "Italic" : `${w}Italic`) : w;
  return `${family.replace(/ /g, "")}-${style}`;
}

function rgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export async function exportPsd(doc: DesignDocument): Promise<Blob> {
  // ag-psd 体积不小：只在点「导出 PSD」时才加载
  const { writePsd } = await import("ag-psd");
  const composite = await buildStage(doc, { background: true });
  const layers = await buildStage(doc, { background: false });
  try {
    const children: PsdLayer[] = [];
    if (doc.canvas.background !== "transparent") {
      const bg = document.createElement("canvas");
      bg.width = doc.canvas.width;
      bg.height = doc.canvas.height;
      const ctx = bg.getContext("2d");
      if (ctx) {
        ctx.fillStyle = cssColor(doc.canvas.background);
        ctx.fillRect(0, 0, bg.width, bg.height);
      }
      children.push({ name: "背景色", left: 0, top: 0, canvas: bg });
    }
    for (const l of doc.layers) {
      const node = layers.nodes.get(l.id);
      if (!node) continue;
      // 旋转烘焙进像素（PSD 像素层不存旋转角度）
      const rect = node.getClientRect();
      const canvas = layers.stage.toCanvas({ ...rect, pixelRatio: 1 });
      const base = {
        name: l.name || l.id,
        left: Math.round(rect.x),
        top: Math.round(rect.y),
        canvas,
        opacity: l.opacity,
        hidden: !l.visible,
      };
      if (l.type === "text") {
        children.push({
          ...base,
          text: {
            text: l.textTransform === "uppercase" ? l.text.toUpperCase() : l.text,
            // 段落文字框：宽度与编辑器一致，换行由 PS 按框宽重排
            shapeType: "box",
            boxBounds: [0, 0, l.width, l.height],
            transform: [1, 0, 0, 1, l.x, l.y],
            style: {
              font: { name: postScriptName(l.fontFamily, l.fontWeight, l.fontStyle === "italic") },
              fontSize: l.fontSize,
              fillColor: rgb(l.fill),
              tracking: Math.round((l.letterSpacing / l.fontSize) * 1000),
              leading: l.fontSize * l.lineHeight,
              underline: l.textDecoration === "underline",
              strikethrough: l.textDecoration === "line-through",
            },
            paragraphStyle: { justification: l.align },
          },
        });
      } else {
        children.push(base);
      }
    }
    const buffer = writePsd(
      {
        width: doc.canvas.width,
        height: doc.canvas.height,
        canvas: composite.stage.toCanvas({ pixelRatio: 1 }),
        children,
      },
      { generateThumbnail: true },
    );
    return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
  } finally {
    composite.destroy();
    layers.destroy();
  }
}
