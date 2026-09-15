"use client";

import { useEffect, useRef } from "react";

import type { CanvasNodeType } from "@/lib/api";

import { CANVAS_NODE_IO, canConnectNodeTypes } from "../_lib/node-io";

import { NODE_META } from "./node-meta";

/**
 * 一次「要在这儿建个节点」的落点信息。两种来源：
 *  - 从端口拖出来松手在空白处 / 点端口上的「+」→ fromId 有值，新节点接上线
 *  - 在画布空白处右键 → fromId 为 null，就地建一个孤立节点
 */
export interface ConnectDrop {
  fromId: string | null;
  fromType: CanvasNodeType | null;
  /** 从出口拉出来 → 新节点在下游；从入口拉出来 → 新节点在上游 */
  direction: "downstream" | "upstream";
  /** 画布坐标（新节点落点） */
  flow: { x: number; y: number };
  /** 相对画布容器的像素坐标（菜单落点） */
  screen: { x: number; y: number };
}

/**
 * 菜单里节点类型的排列顺序：按「流水线上游 → 下游」排，不是字母序。
 * 新增类型必须加进来——候选是先按这张表列举、再按端口契约过滤的，漏了就永远不出现。
 */
const ORDER: CanvasNodeType[] = [
  "image_upload",
  "image_gen",
  "video_gen",
  "video_concat",
];

/**
 * 这次能落成哪些类型的新节点——接线时按端口契约过滤，不给不能接的选项；
 * 空白处右键没有端口约束，四类都能建。
 */
export function candidatesFor(drop: ConnectDrop): CanvasNodeType[] {
  const from = drop.fromType;
  if (!from) return ORDER;
  return ORDER.filter((t) =>
    drop.direction === "downstream"
      ? canConnectNodeTypes(from, t)
      : canConnectNodeTypes(t, from),
  );
}

/**
 * 新建节点菜单。两个入口共用一套：从端口拖到空白处松手，以及在画布空白处右键。
 *
 * 这是同类产品（Krea / Figma Weave / Freepik Spaces / ComfyUI / n8n）一致的标准动作：
 * 松手即问「要接一个什么节点」，选完自动落位并接好线；空白处右键则是画布类工具的通用约定
 * （此前只有双击建 text 一条路，想建生图节点得先建文本再改类型——改不了，只能求 agent）。
 *
 * 接线时候选**按端口类型过滤**——接不了的类型压根不出现在菜单里，比让人选完再报错友好。
 */
export function ConnectDropMenu({
  drop,
  onPick,
  onDismiss,
}: {
  drop: ConnectDrop;
  onPick: (type: CanvasNodeType) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const types = candidatesFor(drop);

  // Esc 关掉；点菜单以外的地方也关掉（画布本身会吃掉 click，故监听 pointerdown）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    // 捕获阶段：react-flow 会在冒泡阶段吞掉画布上的指针事件
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onDismiss]);

  if (types.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute z-30 w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      // 落点由拖拽松手的位置决定，只能内联给（Tailwind 没有运行时任意值）
      style={{ left: drop.screen.x, top: drop.screen.y }}
    >
      <p className="px-2 py-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">
        {!drop.fromId
          ? "Add node"
          : drop.direction === "downstream"
            ? "Send into"
            : "Feed from"}
      </p>
      {types.map((type) => {
        const meta = NODE_META[type];
        return (
          <button
            key={type}
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
            onClick={() => onPick(type)}
          >
            <meta.Icon className="size-3.5 shrink-0" style={{ color: meta.tone }} />
            <span className="min-w-0 flex-1 truncate">{meta.label}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {CANVAS_NODE_IO[type].outputs.join("·")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
