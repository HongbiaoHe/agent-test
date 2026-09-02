"use client";

import { cn } from "@/lib/utils";

import { useDraftField } from "../_hooks/use-draft-field";

/**
 * 卡片标题的就地编辑：标题显示在哪儿就在哪儿改，不再进编辑面板找一个 "Title" 字段。
 *
 * 面板（NodeComposer）留给提示词本身——同类画布（即梦 / Flora / Weave）的浮出面板都是
 * 一个 composer：整段提示词占满面板，底下一条参数条，没有字段表单。标题这种一行的东西
 * 放进 composer 会把它变回表单。
 *
 * 未选中时渲染成静态文本（每张卡都挂一个输入框既费也让整张卡不好拖）；
 * 选中后即是输入框，点一下就能改。
 */
export function NodeTitleField({
  nodeId,
  value,
  editable,
}: {
  nodeId: string;
  value: string;
  /** 节点已选中且可编辑（运行期为 false） */
  editable: boolean;
}) {
  const { draft, onChange, finish } = useDraftField(nodeId, "label", value);
  const shared = "min-w-0 flex-1 text-[13px] leading-snug font-medium";

  if (!editable) {
    return (
      <span
        className={cn(shared, "truncate", !value && "text-muted-foreground")}
      >
        {value || "Untitled"}
      </span>
    );
  }
  return (
    <input
      value={draft}
      aria-label="Node title"
      placeholder="Untitled"
      onChange={(e) => onChange(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        // Enter / Esc 收口并把焦点还给画布；stopPropagation 让编辑期按键
        // 不触发画布快捷键（Delete 删节点、Cmd+D 复制等）
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      // nodrag：在标题里选字不会把整张卡拖走
      className={cn(
        shared,
        "nodrag -mx-1 w-[calc(100%+0.5rem)] rounded-sm bg-transparent px-1 outline-none placeholder:text-muted-foreground focus-visible:bg-muted/60",
      )}
    />
  );
}
