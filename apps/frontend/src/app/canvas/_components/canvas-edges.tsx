"use client";

import {
  BaseEdge,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";

/**
 * 连线 data：
 * - busy   目标节点正在生成（画布状态推导，见 flow-canvas 的 toRfEdges）
 * - active 本帧是否跑流光（busy 或两端有节点被选中，见 flow-canvas 的 flowEdges）
 */
export interface FlowEdgeData extends Record<string, unknown> {
  busy?: boolean;
  active?: boolean;
}

export type FlowEdge = Edge<FlowEdgeData, "flow">;

/**
 * 画布连线：常态就是普通贝塞尔线；active 时在同一条路径上叠一段高亮虚线跑流光，
 * 方向 source → target（表现数据正流入目标节点）。动效见 globals.css .canvas-edge__flow。
 */
function FlowEdgeComponent({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<FlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {data?.active && (
        <path className="canvas-edge__flow" d={path} fill="none" />
      )}
    </>
  );
}

export const edgeTypes: EdgeTypes = { flow: FlowEdgeComponent };
