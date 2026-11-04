"use client";

import {
  imageKonvaAttrs,
  type ImageLayer,
  type Layer,
  textKonvaAttrs,
  type TextLayer,
} from "@agent-test/design-schema";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { useEffect, useRef } from "react";
import { Image as KImage, Rect, Text as KText } from "react-konva";

import { useLoadedImage } from "./use-loaded-image";

/**
 * 一个图层的 Konva 节点。属性全部来自共享的 konva-attrs（与导出、后端渲染同构）；
 * 交互（选中、拖拽、双击编辑）由外层 DesignStage 通过回调接管。
 */

export interface LayerNodeHandlers {
  draggable: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onDragStart: (id: string) => void;
  onDragMove: (e: KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: KonvaEventObject<DragEvent>) => void;
  onEditText: (id: string) => void;
  /** 文字排版后量出的高度与记录不一致时回写 */
  onMeasured: (id: string, height: number) => void;
}

export function LayerNode({
  layer,
  hidden,
  fontsVersion,
  placeholderColor,
  ...h
}: LayerNodeHandlers & {
  layer: Layer;
  /** 原地编辑文字时把画板上的那份藏起来 */
  hidden: boolean;
  /** 字体就绪后递增：触发文字重新量高 */
  fontsVersion: number;
  placeholderColor: string;
}) {
  if (layer.type === "text") {
    return <TextNode layer={layer} hidden={hidden} fontsVersion={fontsVersion} {...h} />;
  }
  return <ImageNode layer={layer} placeholderColor={placeholderColor} {...h} />;
}

function common(layer: Layer, h: LayerNodeHandlers) {
  return {
    id: layer.id,
    name: "design-layer",
    draggable: h.draggable && !layer.locked,
    listening: !layer.locked,
    onMouseDown: (e: KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      h.onSelect(layer.id, e.evt.shiftKey || e.evt.metaKey);
    },
    onTap: () => h.onSelect(layer.id, false),
    onDragStart: () => h.onDragStart(layer.id),
    onDragMove: h.onDragMove,
    onDragEnd: h.onDragEnd,
  };
}

function ImageNode({
  layer,
  placeholderColor,
  ...h
}: LayerNodeHandlers & { layer: ImageLayer; placeholderColor: string }) {
  const image = useLoadedImage(layer.src);
  const attrs = imageKonvaAttrs(layer);
  if (!image) {
    // 首次生成中 / 无图：画一个可选中、可拖拽的占位框（生成动效由 DOM 覆盖层负责）
    return (
      <Rect
        {...attrs}
        {...common(layer, h)}
        fill={placeholderColor}
        opacity={layer.opacity * 0.5}
        cornerRadius={4}
      />
    );
  }
  return <KImage {...attrs} {...common(layer, h)} image={image} />;
}

function TextNode({
  layer,
  hidden,
  fontsVersion,
  ...h
}: LayerNodeHandlers & { layer: TextLayer; hidden: boolean; fontsVersion: number }) {
  const ref = useRef<Konva.Text>(null);
  const attrs = textKonvaAttrs(layer);
  const { onMeasured } = h;

  // 宽度固定、高度随内容：渲染后量一次，与记录差 >2px 才回写（避免抖动反复提交）
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measured = node.height();
    if (Math.abs(measured - layer.height) > 2) onMeasured(layer.id, measured);
  }, [layer, fontsVersion, onMeasured]);

  return (
    <KText
      ref={ref}
      {...attrs}
      {...common(layer, h)}
      visible={layer.visible && !hidden}
      onDblClick={() => h.onEditText(layer.id)}
      onDblTap={() => h.onEditText(layer.id)}
    />
  );
}
