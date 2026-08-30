"use client";

import { Panel, useReactFlow } from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  CANVAS_ISLAND_CLASS,
  CanvasIslandButton,
  CanvasIslandDivider,
} from "./canvas-island";

/**
 * 画布缩放控件。替掉 react-flow 自带的 `<Controls>`——它自带一套与本项目无关的配色，
 * 在暗色下尤其突兀。这里走画布统一的浮岛外观（见 canvas-island），横置于底部居中。
 *
 * 必须渲染在 <ReactFlow> 内部：useReactFlow 依赖它的 provider。
 */
export function CanvasZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel
      position="bottom-center"
      // ⚠️ 别去改左右 margin：react-flow 的居中规则是
      // `left:50%; transform: translateX(-15px) translateX(-50%)`——那个 -15px 是用来
      // 抵消它自己 `.react-flow__panel { margin: 15px }` 的。把 mx 清零反而会净偏 15px。
      // 只覆盖底边距，对齐其它悬浮元素的 12px 留白。
      className={cn("!mb-3", CANVAS_ISLAND_CLASS)}
    >
      <CanvasIslandButton
        icon={<Plus className="size-4" />}
        label="Zoom in"
        tooltipSide="top"
        onClick={() => void zoomIn()}
      />
      <CanvasIslandButton
        icon={<Minus className="size-4" />}
        label="Zoom out"
        tooltipSide="top"
        onClick={() => void zoomOut()}
      />
      <CanvasIslandDivider />
      <CanvasIslandButton
        icon={<Maximize className="size-4" />}
        label="Fit view"
        tooltipSide="top"
        onClick={() => void fitView({ padding: 0.2 })}
      />
    </Panel>
  );
}
