"use client";

import { NodeToolbar, Position, type Node } from "@xyflow/react";
import { Copy, MessagesSquare, Trash2 } from "lucide-react";

import {
  CanvasToolbar,
  CanvasToolbarAction,
  CanvasToolbarButton,
  CanvasToolbarCount,
  CanvasToolbarSeparator,
} from "./canvas-toolbar";

/**
 * 多选工具条：框选或 Shift 点选出两个以上节点时，浮在整片选区正上方。
 *
 * 药丸与按钮的样式/交互来自 CanvasToolbar（与节点 hover 操作组同一套）。
 *
 * 位置交给 react-flow 的 <NodeToolbar>——它的 nodeId 可以传一个数组，会自己贴到这组节点的
 * 包围盒上方，且**不随画布缩放变大变小**（屏幕空间恒定尺寸）。同类产品（n8n / ComfyUI）
 * 自己手写的定位算法算的也是这个：并集包围盒中心、顶部再抬 10~12px。
 *
 * 出不出现由调用方决定（见 flow-canvas）：≥2 个，或「按组选中」的单个——按住修饰键/框选
 * 挑出来的那一个，用户要的是把它加进对话，不是编辑它。普通点击单个节点走编辑面板
 * （NodeComposer），两者都停在节点上方，同时出现会打架。
 */
export function SelectionToolbar({
  nodes,
  focused,
  onAddToChat,
  onDuplicate,
  onDelete,
}: {
  /** 当前选中的节点（react-flow 本地选中态） */
  nodes: Node[];
  /** 这组节点是否已经全部圈进对话了——是则按钮变成「取消圈定」 */
  focused: boolean;
  onAddToChat: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const ids = nodes.map((n) => n.id);
  if (ids.length === 0) return null;

  return (
    <NodeToolbar isVisible nodeId={ids} position={Position.Top} offset={12}>
      <CanvasToolbar>
        {/* 主操作放最左并带文字：这条工具条存在的主要理由就是它 */}
        <CanvasToolbarAction
          label={focused ? "In chat context" : "Add to chat"}
          icon={<MessagesSquare className="size-3.5" />}
          active={focused}
          onClick={onAddToChat}
          tooltip={
            focused
              ? "Agent sees only these nodes — click to undo"
              : "Limit the agent to these nodes"
          }
        />
        <CanvasToolbarSeparator />
        <CanvasToolbarCount value={ids.length} />
        <CanvasToolbarButton
          label="Duplicate"
          icon={<Copy className="size-3.5" />}
          onClick={onDuplicate}
        />
        <CanvasToolbarButton
          label="Delete"
          icon={<Trash2 className="size-3.5" />}
          danger
          onClick={onDelete}
        />
      </CanvasToolbar>
    </NodeToolbar>
  );
}
