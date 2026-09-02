"use client";

import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { CornerUpLeft, Minimize2 } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import type { CanvasNodeType } from "@/lib/api";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

import { useDraftField } from "../_hooks/use-draft-field";
import { useIsMobile } from "../_hooks/use-is-mobile";
import { CanvasEditorContext, type NodeContentPatch } from "./flow-canvas";
import { NodeTypeIcon, NODE_META } from "./node-meta";

/**
 * 可编辑正文。只有 text 节点有——生成节点的提示词来自上游 text 节点，
 * 自身不存 prompt（见 canvas.types 的 CANVAS_NODE_IO）。
 */
export interface NodeBodyField {
  field: Extract<keyof NodeContentPatch, "text">;
  value: string;
  placeholder: string;
}

/**
 * 生成节点的一路提示词来源：一个上游 text 节点，及它此刻提供的正文。
 * 生成节点自身不存 prompt，面板里显示的每一段都属于某张 text 卡（点它可以跳过去）。
 */
export interface PromptSource {
  nodeId: string;
  title: string;
  text: string;
}

/** 面板与节点之间的间距（同时作为「空间是否够放」的余量） */
const GAP = 12;
/** 首帧还没量到面板尺寸时的估值 */
const FALLBACK_W = 416;
const FALLBACK_H = 200;
/** 提示词输入框自适应高度的上限，超过就在框内滚动 */
const MAX_BODY_H = 300;

/**
 * 选一个不溢出画布容器的面板方位：优先上方 → 下方 → 右侧 → 左侧。
 * 用 DOM 实测矩形（已含缩放），避免自己换算 viewport transform。
 */
function pickPosition(nodeId: string, size: { w: number; h: number }): Position {
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
 * 节点的提示词面板（composer）。选中节点时浮在节点旁，跟随节点位置与画布缩放。
 *
 * 形态照同类画布的 composer 来：**整段提示词就是面板本身**——一整块无边框的文字铺满面板，
 * 上方只留一枚收起键，底下一条参数条（类型 / 上游来源 / 保存状态）。
 * 不做成表单：字段小标题、描边输入框、"Edit node" 标题都会把注意力从提示词上引开，
 * 而写提示词才是在这张面板上唯一要做的事。标题不在这里改——它就在卡片上，点一下即可改
 * （见 NodeTitleField）。
 *
 * 生成节点没有自己的提示词，面板此时是**只读**的：显示本次生成会用的上游文本，
 * 让人在触发生成前先确认一遍。
 */
export function NodeComposer({
  nodeId,
  nodeType,
  selected,
  dragging,
  body,
  promptSources,
  meta,
  actions,
}: {
  nodeId: string;
  nodeType: CanvasNodeType;
  selected: boolean;
  /** 正在拖拽：拖动期间不显示（跟手时挡视线、也易误触输入框） */
  dragging: boolean;
  /** 可编辑正文（text 节点） */
  body?: NodeBodyField;
  /** 提示词来源（生成节点：每段来自一张上游 text 卡） */
  promptSources?: PromptSource[];
  /** 参数条上除类型外的补充信息（上游来源摘要等） */
  meta?: React.ReactNode;
  /** 节点操作（看大图 / 下载 / 复制 / 删除）。触屏没有 hover，只能挂在这里 */
  actions?: React.ReactNode;
}) {
  const { readOnly, clearSelection } = useContext(CanvasEditorContext);
  const isMobile = useIsMobile();
  const visible = selected && !readOnly && !dragging;

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
    const raf = requestAnimationFrame(measure); // 下一帧用实测尺寸校正
    return () => cancelAnimationFrame(raf);
  }, [visible, nodeId, transform]);

  // Esc 收起面板。焦点在输入框里时由输入框自己的 keydown 先收口再冒泡到这里。
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, clearSelection]);

  const prompt = body ? (
    <PromptInput
      nodeId={nodeId}
      field={body.field}
      value={body.value}
      placeholder={body.placeholder}
    />
  ) : (
    <UpstreamPromptView nodeId={nodeId} sources={promptSources ?? []} />
  );

  // 参数条：交代「这是什么节点、料从哪来」。
  // 桌面端不放复制/删除——它们已经常驻在卡片上方那条 hover 操作条上（见 NodeActions），
  // 同一组按钮出现两次只会让人犹豫该按哪个。触屏没有 hover，抽屉里才补上。
  const bar = (
    <div className="flex items-center gap-1.5">
      <Pill>
        <NodeTypeIcon type={nodeType} />
        {NODE_META[nodeType].label}
      </Pill>
      {meta}
    </div>
  );

  // 手机：底部抽屉。面板在窄屏上要么挡住半张画布、要么被挤到边缘。
  // 关闭即取消选中（否则 selected 还在，抽屉会立刻弹回来）。
  if (isMobile) {
    return (
      <Drawer
        open={visible}
        onOpenChange={(open) => {
          if (!open) clearSelection();
        }}
        showSwipeHandle
        /* 非模态：模态会盖一层遮罩吃掉画布上的点击，导致既不能点空白取消选中、
           也不能直接点另一个节点切换编辑对象。 */
        modal={false}
      >
        <DrawerContent style={{ minHeight: "50dvh", maxHeight: "80dvh" }}>
          <DrawerHeader className="sr-only">
            <DrawerTitle>Node prompt</DrawerTitle>
          </DrawerHeader>
          <div className="nodrag nowheel min-h-0 flex-auto space-y-3 overflow-y-auto px-4 pt-2 pb-4">
            {prompt}
          </div>
          <div className="flex items-center gap-1.5 border-t border-border px-4 py-3">
            <Pill>
              <NodeTypeIcon type={nodeType} />
              {NODE_META[nodeType].label}
            </Pill>
            {meta}
            {actions && <div className="ml-auto">{actions}</div>}
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
        className="nodrag nowheel w-[26rem] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        {/* 顶上只有收起键：composer 里除了提示词，其它都该让位 */}
        <div className="flex justify-end">
          <button
            type="button"
            aria-label="Collapse"
            title="Collapse"
            onClick={clearSelection}
            className="-mt-1 -mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minimize2 className="size-3.5" />
          </button>
        </div>
        <div className="px-1 pb-3">{prompt}</div>
        {bar}
      </div>
    </NodeToolbar>
  );
}

/** 参数条上的一枚胶囊：图标 + 一句话，安静地交代上下文。 */
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 提示词输入：无边框、占满面板、高度贴着内容长。
 * 这是整张面板唯一的主角，所以给到最大的字号与行距——写长文时读得下去。
 */
function PromptInput({
  nodeId,
  field,
  value,
  placeholder,
}: {
  nodeId: string;
  field: NodeBodyField["field"];
  value: string;
  placeholder: string;
}) {
  const { draft, onChange, finish } = useDraftField(nodeId, field, value);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 高度贴着内容长：先归零再读 scrollHeight（不归零读到的是上一次撑开后的高度），
  // 到 MAX_BODY_H 封顶后转为内部滚动
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_BODY_H)}px`;
  }, [draft]);

  return (
    <textarea
      ref={ref}
      value={draft}
      aria-label="Prompt"
      placeholder={placeholder}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
        e.stopPropagation(); // 编辑期按键不触发画布快捷键
      }}
      className="w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
    />
  );
}

/**
 * 生成节点的提示词区。两种状态，都对应「提示词只能住在 text 节点里」这条后端契约：
 *
 *  - 已接上游：显示每张上游 text 卡的正文，**点一下跳到那张卡**。此前这里是一段死文字，
 *    想改提示词得自己在画布上找出是哪张卡喂的——连线多了就找不着。
 *  - 没接上游：直接在这儿写。写完落成一张真的 text 卡并自动接线（见 addPromptNode）——
 *    不这么做的话，写进生成节点自己的 text 字段是句空话，后端生成时根本不看它。
 */
function UpstreamPromptView({
  nodeId,
  sources,
}: {
  nodeId: string;
  sources: PromptSource[];
}) {
  const { focusNode } = useContext(CanvasEditorContext);
  if (sources.length === 0) return <PromptDraft nodeId={nodeId} />;
  return (
    <div className="space-y-2">
      {sources.map((src) => (
        <button
          key={src.nodeId}
          type="button"
          title="Open the text node that provides this"
          onClick={() => focusNode(src.nodeId)}
          className="group/src -mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
        >
          {/* 多路上游才标出各段出处：只有一路时标题是噪音 */}
          {sources.length > 1 && (
            <span className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <CornerUpLeft className="size-2.5" aria-hidden />
              {src.title}
            </span>
          )}
          <span className="block text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {src.text}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 没有上游 text 时的就地起草：写完（失焦或面板收起）落成一张上游 text 卡并接好线。
 * 不用 useDraftField——那是改已有节点的，这里目标节点还不存在。
 */
function PromptDraft({ nodeId }: { nodeId: string }) {
  const { addPromptNode } = useContext(CanvasEditorContext);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_BODY_H)}px`;
  }, [draft]);

  // 收口只做一次：失焦提交后组件常常紧接着卸载（面板收起），卸载再提交会建出第二张卡。
  // 但**空内容不算收口**——StrictMode 开发期会先挂载再卸载一次，那次卸载带着空草稿，
  // 若也置上标记，后面真正写完的那次提交就被自己吞掉了（表现为写完什么都没发生）。
  // commit 挂 ref 上取最新闭包，卸载 effect 因此只需跑一次（渲染期不能改 ref，故放 effect 里）。
  const done = useRef(false);
  const commit = (text: string) => {
    if (done.current || !text.trim()) return;
    done.current = true;
    addPromptNode(nodeId, text);
  };
  const pending = useRef<() => void>(() => {});
  useEffect(() => {
    pending.current = () => commit(draft);
  });
  useEffect(() => () => pending.current(), []);

  return (
    <div className="space-y-1.5">
      <textarea
        ref={ref}
        value={draft}
        aria-label="Prompt"
        placeholder="Write the prompt…"
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
          e.stopPropagation();
        }}
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      {/* 说清代价：这一段会变成画布上一张新的 text 卡，不是藏在这个节点里 */}
      <p className="text-[10px] text-muted-foreground/70">
        Saved as a linked text node
      </p>
    </div>
  );
}
