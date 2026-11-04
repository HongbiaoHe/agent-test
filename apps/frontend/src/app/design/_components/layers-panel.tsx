"use client";

import type { Layer } from "@agent-test/design-schema";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers,
  Loader2,
  Lock,
  Type,
  Unlock,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { type DesignStore, useEditor } from "../_lib/store";

/**
 * 左侧图层面板：自上而下 = z 序自顶向下（数组倒序显示）。拖拽排序、显隐、锁定、双击改名；
 * agent 刚动过的行会亮一下并带「AI」标记，生成中的行有转圈。
 */
export function LayersPanel({ store }: { store: DesignStore }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const touched = useEditor(store, (s) => s.agentTouched);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const rows = [...doc.layers].reverse();
  const patch = (id: string, p: Partial<Pick<Layer, "visible" | "locked" | "name">>) =>
    store.apply([{ type: "update_layers", updates: [{ id, patch: p }] }]);

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    // 在倒序列表里把 dragId 放到 targetId 的位置，再换回自底向上的顺序
    const order = rows.map((l) => l.id).filter((id) => id !== dragId);
    order.splice(order.indexOf(targetId), 0, dragId);
    store.apply([{ type: "reorder_layers", order: order.reverse() }]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold">图层</span>
        <span className="text-xs text-muted-foreground tabular-nums">{doc.layers.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <Layers className="size-5" />
            还没有图层。用左侧工具添加文字或图片，或者让 Agent 从一句话开始。
          </div>
        )}
        {rows.map((l) => {
          const selected = selection.includes(l.id);
          const aiFresh = Boolean(touched[l.id]);
          return (
            <div
              key={l.id}
              draggable={renaming !== l.id}
              onDragStart={() => setDragId(l.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(l.id);
              }}
              onDragLeave={() => setOverId((o) => (o === l.id ? null : o))}
              onDrop={() => {
                drop(l.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onClick={(e) => {
                const cur = store.getState().selection;
                if (e.shiftKey || e.metaKey) {
                  store.select(cur.includes(l.id) ? cur.filter((x) => x !== l.id) : [...cur, l.id]);
                } else {
                  store.select([l.id]);
                }
              }}
              className={cn(
                "group relative flex h-10 cursor-default items-center gap-2 rounded-lg px-2 text-sm transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                !l.visible && "text-muted-foreground",
                dragId === l.id && "opacity-40",
                overId === l.id && dragId !== l.id && "ring-1 ring-selection",
                aiFresh && !selected && "bg-agent/6",
              )}
            >
              <Thumb layer={l} />
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  onBlur={(e) => {
                    setRenaming(null);
                    const name = e.target.value.trim().slice(0, 80);
                    if (name && name !== l.name) patch(l.id, { name });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenaming(l.id);
                  }}
                >
                  {l.name || (l.type === "text" ? l.text : "图片")}
                </span>
              )}
              {aiFresh && (
                <span title="Agent 刚修改" aria-label="Agent 刚修改" className="size-1.5 shrink-0 rounded-full bg-agent" />
              )}
              {l.type === "image" && l.status === "generating" && (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-agent" aria-label="生成中" />
              )}
              {l.type === "image" && l.status === "error" && (
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label="生成失败" />
              )}
              <IconToggle
                label={l.locked ? "解锁" : "锁定"}
                onClick={() => patch(l.id, { locked: !l.locked })}
                icon={l.locked ? Lock : Unlock}
                persistent={l.locked}
              />
              <IconToggle
                label={l.visible ? "隐藏" : "显示"}
                onClick={() => patch(l.id, { visible: !l.visible })}
                icon={l.visible ? Eye : EyeOff}
                persistent={!l.visible}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconToggle({
  label,
  onClick,
  icon: Icon,
  persistent,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Eye;
  /** 处于「非默认」状态时常显，否则悬停才显示 */
  persistent: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground",
        persistent ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function Thumb({ layer }: { layer: Layer }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-size-[8px_8px] ring-1 ring-border">
      {layer.type === "text" ? (
        <Type className="size-3.5 text-foreground" />
      ) : layer.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- CDN 上的用户图，缩略图不走 next/image
        <img src={layer.src} alt="" className="size-full object-contain" />
      ) : (
        <ImageIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}
