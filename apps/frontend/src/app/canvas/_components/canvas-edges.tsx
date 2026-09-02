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
 * 画布连线：常态是普通贝塞尔线；active（目标在生成 / 两端有节点被选中）时把同一条路径
 * 加粗提亮，**静态**强调；被选中时整条换成高饱和色（--edge-selected）。
 *
 * 早先这里跑的是一段沿线流动的高光虚线。查了一圈同类产品（ComfyUI / n8n / Figma Weave）
 * 没有一家给连线做流光——它既抢注意力，又是"AI 感"最典型的装饰性动效。「在跑」这件事
 * 表达在节点上（骨架 + 状态条）就够了，线只负责说清"谁接谁"。
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
  selected,
}: EdgeProps<FlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  // 选中色走内联而不是 CSS：react-flow 自带的 .react-flow__edge.selected 规则与我们的
  // 选择器同特异性、且在层叠里排得更后，写在 globals.css 里会被它压掉（实测 stroke 仍是
  // react-flow 的灰）。内联样式不参与这场比大小。
  const selectedStroke = selected
    ? { stroke: "var(--edge-selected)", strokeWidth: 2.5 }
    : null;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, ...selectedStroke }}
      />
      {data?.active && (
        <path
          className="canvas-edge__active"
          d={path}
          fill="none"
          style={selectedStroke ?? undefined}
        />
      )}
    </>
  );
}

export const edgeTypes: EdgeTypes = { flow: FlowEdgeComponent };
