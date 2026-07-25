"use client";

import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { useContext, useEffect, useRef, useState } from "react";

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

import { useIsMobile } from "../_hooks/use-is-mobile";
import { CanvasEditorContext, type NodeContentPatch } from "./flow-canvas";
import { NodeInputList } from "./node-input-list";

/**
 * 编辑面板里的正文字段。目前只有 text 节点有——生成节点的提示词来自上游 text 节点，
 * 自身没有可编辑正文（见 canvas.types 的 CANVAS_NODE_IO）。
 */
export interface NodeBodyField {
  field: Extract<keyof NodeContentPatch, "text">;
  value: string;
  placeholder: string;
}

/** 输入停止后自动保存的防抖时长（失焦会立即收口，不必等它）。 */
const DEBOUNCE_MS = 600;
/** 浮窗与节点之间的间距（同时作为「空间是否够放」的余量） */
const GAP = 12;
/** 首帧还没量到浮窗尺寸时的估值（w-72 = 288px；高度按 label+正文估） */
const FALLBACK_W = 288;
const FALLBACK_H = 210;

/**
 * 选一个不溢出画布容器的浮窗方位：优先上方 → 下方 → 右侧 → 左侧。
 * 用 DOM 实测矩形（已含缩放），避免自己换算 viewport transform。
 */
function pickPosition(
  nodeId: string,
  size: { w: number; h: number },
): Position {
  const nodeEl = document.querySelector(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
  );
  const flowEl = nodeEl?.closest(".react-flow");
  if (!nodeEl || !flowEl) return Position.Top;
  const n = nodeEl.getBoundingClientRect();
  const f = flowEl.getBoundingClientRect();
  if (n.top - f.top >= size.h + GAP) return Position.Top;
  if (f.bottom - n.bottom >= size.h + GAP) return Position.Bottom;
  if (f.right - n.right >= size.w + GAP) return Position.Right;
  return Position.Left;
}

/**
 * 节点编辑浮窗：选中节点时浮在节点上方（NodeToolbar 自动跟随节点位置与画布缩放）。
 *
 * 交互：改内容 → 停止输入 600ms 或失焦即提交 update_node（值未变不提交）；
 * 右上角实时显示保存状态（保存中 / 已保存 / 失败）。运行期（readOnly）不显示。
 */
export function NodeEditorToolbar({
  nodeId,
  selected,
  dragging,
  label,
  labelPlaceholder,
  body,
}: {
  nodeId: string;
  selected: boolean;
  /** 正在拖拽：拖动期间不显示浮窗（跟手时挡视线、也易误触输入框） */
  dragging: boolean;
  label: string;
  labelPlaceholder: string;
  body?: NodeBodyField;
}) {
  const { readOnly, resolveInputs, clearSelection } =
    useContext(CanvasEditorContext);
  const isMobile = useIsMobile();
  const visible = selected && !readOnly && !dragging;
  // 只有浮窗真的浮出时才解析（未选中的节点不必算，也不必拉缩略图）
  const inputs = visible ? resolveInputs(nodeId) : [];

  // 平移/缩放会改变节点在容器内的位置 → 需要重算方位（订阅 transform 触发重渲染）
  const transform = useStore((s) => s.transform.join(","));
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position>(Position.Top);

  useEffect(() => {
    if (!visible) return;
    const measure = () => {
      const r = boxRef.current?.getBoundingClientRect();
      setPosition(
        pickPosition(nodeId, {
          w: r?.width || FALLBACK_W,
          h: r?.height || FALLBACK_H,
        }),
      );
    };
    measure(); // 首帧用估值定位
    // 下一帧用实测尺寸校正（浮窗此时已挂载）
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // dragging 结束（节点换了位置）与 transform 变化都要重算
  }, [visible, nodeId, transform]);

  // 两端共用的编辑内容（保存进度不在此处显示——统一在画布左上角，见 flow-canvas 的 SaveStatusBadge）
  const fields = (
    <>
      <FieldLabel text="Title">
        <Field
          nodeId={nodeId}
          field="label"
          value={label}
          placeholder={labelPlaceholder}
          single
        />
      </FieldLabel>
      {body && (
        <FieldLabel text="Text">
          <Field
            nodeId={nodeId}
            field={body.field}
            value={body.value}
            placeholder={body.placeholder}
          />
        </FieldLabel>
      )}
      {/* 关联输入：沿入边列出上游节点的输出（生成时会参考这些资源） */}
      <NodeInputList inputs={inputs} />
    </>
  );

  // 手机：底部抽屉。浮窗在窄屏上要么挡住半张画布、要么被挤到边缘，且 288px 宽的输入框很难点。
  // 关闭即取消选中（否则 selected 还在，抽屉会立刻弹回来）。
  // DrawerContent 走 Portal 渲染到 body，因此不受 react-flow viewport 的 transform 影响。
  if (isMobile) {
    return (
      <Drawer
        open={visible}
        onOpenChange={(open) => {
          if (!open) clearSelection();
        }}
        showSwipeHandle
        /* 非模态：模态会盖一层遮罩吃掉画布上的点击，导致既不能点空白取消选中、
           也不能直接点另一个节点切换编辑对象。非模态下 viewport 是 pointer-events:none，
           只有抽屉自身收事件，画布照常可点——与桌面浮窗的行为一致。 */
        modal={false}
      >
        {/* 高度区间：至少半屏（内容少时不至于缩成一条贴在底边），最多 80%（别把画布全盖住），
            之间随内容自适应，超出即在内容区滚动。
            min/max 都走内联样式：基础类里的 min-h-0 与
            data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-6rem)] 带属性选择器、
            特异性更高，用类名或改 CSS 变量都压不过它（实测 max-height 仍是 716px）。 */}
        <DrawerContent style={{ minHeight: "50dvh", maxHeight: "80dvh" }}>
          {/* 标题行左对齐 + 右侧类型标识（DrawerHeader 默认居中，这里覆盖成两端对齐） */}
          <DrawerHeader className="flex-row items-center justify-between gap-2 pb-3 text-left">
            <DrawerTitle className="text-sm">Edit node</DrawerTitle>
            <TypeBadge text={labelPlaceholder} />
          </DrawerHeader>
          {/* nodrag/nowheel：面板内输入不拖动画布、不缩放。
              flex-auto（flex:1 1 auto）而不是 flex-1（flex:1 1 0%）：basis 为 0 时这个子元素
              不参与父级 height:auto 的计算，抽屉会一直塌在 min-height 的 50% 不肯长高，
              内容多了就被截掉。basis:auto 后抽屉按内容长，到 80% 封顶再内部滚动。 */}
          <div className="nodrag nowheel min-h-0 flex-auto space-y-3 overflow-y-auto px-4 pb-6">
            {fields}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <NodeToolbar isVisible={visible} position={position} offset={GAP}>
      {/* nodrag/nowheel：面板内输入不拖动画布、不缩放 */}
      <div
        ref={boxRef}
        className="nodrag nowheel w-72 space-y-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">Edit node</span>
          <TypeBadge text={labelPlaceholder} />
        </div>
        {fields}
      </div>
    </NodeToolbar>
  );
}

/** 节点类型标识（Text / Upload / Image / Video）：面板里唯一提示"在编辑哪类节点"的地方。 */
function TypeBadge({ text }: { text: string }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {text}
    </span>
  );
}

/** 字段小标题：包一层 label，点标题也能聚焦到输入框。 */
function FieldLabel({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {text}
      </span>
      {children}
    </label>
  );
}

/**
 * 单个可编辑字段：本地草稿 + 防抖/失焦提交。
 * 外部值变化（agent 改了同一节点、或 409 重拉快照）时同步草稿，避免显示过期内容。
 */
function Field({
  nodeId,
  field,
  value,
  placeholder,
  single = false,
}: {
  nodeId: string;
  field: keyof NodeContentPatch;
  value: string;
  placeholder: string;
  /** 单行模式（label 用 input，Enter 收口） */
  single?: boolean;
}) {
  const { updateNode, markSaving, cancelSaving } =
    useContext(CanvasEditorContext);
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 已提交（或外部同步到）的值：作为「是否变化」的比较基准，避免重复发同一 op
  const committed = useRef(value);
  // 是否正在输入：输入期不接受外部同步，防止把用户没打完的字覆盖掉
  const typing = useRef(false);

  useEffect(() => {
    if (typing.current) return;
    committed.current = value;
    setDraft(value);
  }, [value]);

  function commit(text: string) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // 内容回退到原值：没有 op 要发，撤销键入时点亮的 loading
    if (text === committed.current) {
      cancelSaving(nodeId);
      return;
    }
    committed.current = text;
    updateNode(nodeId, { [field]: text });
  }

  function onChange(text: string) {
    typing.current = true;
    setDraft(text);
    // 键入即亮 loading（不等 600ms 防抖到点发请求）——"触发就开始，直至保存成功"
    markSaving(nodeId);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(text), DEBOUNCE_MS);
  }

  function finish() {
    typing.current = false;
    commit(draft);
  }

  // 卸载（取消选中 / 切画布）时把未到点的编辑提交掉，不丢改动
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  const stopKeys = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === "Escape" || (e.key === "Enter" && single)) {
      finish();
      e.currentTarget.blur(); // 失焦即收口，同时把画布焦点还回去
    }
    e.stopPropagation(); // 编辑期按键不触发画布快捷键（Delete 删节点、Cmd+D 复制等）
  };

  // 对齐设计系统：rounded-md + 语义 token + 与 Button 同一套焦点环（ring-3 ring-ring/50）
  const shared =
    "w-full rounded-md border border-input bg-background text-foreground outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
  return single ? (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={finish}
      onKeyDown={stopKeys}
      className={cn(shared, "px-2 py-1 text-sm font-medium")}
    />
  ) : (
    <textarea
      value={draft}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={finish}
      onKeyDown={stopKeys}
      className={cn(shared, "min-h-24 resize-y p-2 text-xs")}
    />
  );
}
