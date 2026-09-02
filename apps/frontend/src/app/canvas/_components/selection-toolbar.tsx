"use client";

import { NodeToolbar, Position, type Node } from "@xyflow/react";
import { Copy, MessagesSquare, Trash2 } from "lucide-react";

/**
 * 多选工具条：框选或 Shift 点选出两个以上节点时，浮在整片选区正上方。
 *
 * 位置交给 react-flow 的 <NodeToolbar>——它的 nodeId 可以传一个数组，会自己贴到这组节点的
 * 包围盒上方，且**不随画布缩放变大变小**（屏幕空间恒定尺寸）。同类产品（n8n / ComfyUI）
 * 自己手写的定位算法算的也是这个：并集包围盒中心、顶部再抬 10~12px。
 *
 * 只在 ≥2 个时出现：选中单个节点走的是编辑面板（NodeEditorToolbar），两者都停在节点上方，
 * 同时出现会打架。
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
  if (ids.length < 2) return null;

  return (
    <NodeToolbar isVisible nodeId={ids} position={Position.Top} offset={12}>
      {/* nodrag/nowheel：按在工具条上不拖动画布、不缩放 */}
      <div className="nodrag nowheel flex items-center gap-0.5 rounded-full border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        {/* 主操作放最左并带文字：这条工具条存在的主要理由就是它 */}
        <button
          type="button"
          onClick={onAddToChat}
          className={
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors " +
            (focused
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent hover:text-accent-foreground")
          }
        >
          <MessagesSquare className="size-3.5" />
          {focused ? "In chat context" : "Add to chat"}
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
        <span className="px-1 font-mono text-[10px] text-muted-foreground">
          {ids.length}
        </span>
        <SelectionButton
          label="Duplicate"
          icon={<Copy className="size-3.5" />}
          onClick={onDuplicate}
        />
        <SelectionButton
          label="Delete"
          icon={<Trash2 className="size-3.5" />}
          danger
          onClick={onDelete}
        />
      </div>
    </NodeToolbar>
  );
}

function SelectionButton({
  label,
  icon,
  danger,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={
        "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent " +
        (danger ? "hover:text-destructive" : "hover:text-foreground")
      }
    >
      {icon}
    </button>
  );
}
