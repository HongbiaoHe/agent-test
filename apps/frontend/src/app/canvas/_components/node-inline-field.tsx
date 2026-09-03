"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

import { useDraftField } from "../_hooks/use-draft-field";

/**
 * 卡片标题的就地编辑。标题住在卡片**上方**那一行（卡外，见 NodeShell 的 canvas-node__above）：
 * 出片后的媒体卡卡面只剩画面，标题在卡里就没地方待了；放到上方那行，四类节点才都有名字。
 *
 * 点一下就进编辑（不必先选中节点）——`onClick` 里挡住冒泡，免得这一下顺带把节点选中、
 * 弹出的编辑面板正好盖住这一行。未编辑时渲染成静态文本：每张卡都常驻一个输入框既费，
 * 也拿不到 `text-overflow: ellipsis` 那种干净的省略。
 *
 * 没起过名的节点显示**类型名**（MERGE / IMAGE …）作占位，保持画布原有的 mono 小写标签语言；
 * 起过名就换成常规字体——用户写的中文标题套上等宽大写会很难读。
 */
export function NodeTitleField({
  nodeId,
  value,
  placeholder,
  editable,
}: {
  nodeId: string;
  value: string;
  /** 没有标题时顶上的占位（节点类型名） */
  placeholder: string;
  /** 可编辑（运行期为 false） */
  editable: boolean;
}) {
  const { draft, onChange, finish } = useDraftField(nodeId, "label", value);
  const [editing, setEditing] = useState(false);

  // 上限是整行宽度（行宽 = 卡宽），超出省略——hover 浮出的操作药丸是绝对定位盖在上面的，
  // 不参与这里的宽度分配，所以标题不会一悬停就被挤短、重排。
  //
  // pointer-events-auto 是必需的：所在的那一行默认不吃指针事件（否则每张卡上方都压着一条
  // 看不见的挡板，画布拖不动），于是标题必须自己把指针要回来，才能直接点它进编辑。
  // 静止态**不用 flex-1**：那样整行都成了热区，等于把挡板又装回去；贴着文字宽就够点了。
  const shared =
    "nodrag pointer-events-auto min-w-0 truncate text-[11px] leading-tight";

  if (editable && editing) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label="Node title"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          finish();
          setEditing(false);
        }}
        onKeyDown={(e) => {
          // Enter / Esc 收口并把焦点还给画布；stopPropagation 让编辑期按键
          // 不触发画布快捷键（Delete 删节点、Cmd+D 复制等）
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        // 编辑态占满整行：这会儿药丸已经让开（见 globals.css 的 :has(input:focus)），
        // 给足写字的地方，短标题也不至于挤在一个默认宽度的小框里
        className={cn(
          shared,
          "-mx-1 flex-1 rounded-sm bg-background/80 px-1 font-medium text-foreground outline-none placeholder:text-muted-foreground focus-visible:bg-background",
        )}
      />
    );
  }

  return (
    <span
      title={value || placeholder}
      onClick={
        editable
          ? (e) => {
              // 挡住冒泡：这一下只进编辑态，不要顺带选中节点（选中会弹出编辑面板盖住本行）
              e.stopPropagation();
              setEditing(true);
            }
          : undefined
      }
      className={cn(
        shared,
        value
          ? "font-medium text-foreground/75"
          : // 没起名：沿用画布原有的类型标签样式（等宽大写小字）
            "canvas-node__type",
        editable && "cursor-text",
      )}
    >
      {value || placeholder}
    </span>
  );
}
