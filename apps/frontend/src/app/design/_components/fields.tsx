"use client";

import { type ReactNode, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * 属性面板的字段原语（组合 shadcn Input）。数值字段：输入中不提交，回车 / 失焦才提交一次 op，
 * 也支持在标签上左右拖动微调（设计工具的常见手感）。
 */

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-3.5 last:border-b-0">
      <div className="mb-2.5 flex h-5 items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">
          {title}
        </h3>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2", className)}>{children}</div>;
}

export function NumberField({
  label,
  value,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
  precision = 0,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  precision?: number;
}) {
  const shown = Number(value.toFixed(precision));
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    setDraft(null);
    const v = Number(raw);
    if (Number.isFinite(v) && v !== shown) onCommit(clamp(v));
  };

  /** 标签上按住左右拖：每像素一个 step，松手提交 */
  const startScrub = (e: React.PointerEvent<HTMLSpanElement>) => {
    const startX = e.clientX;
    const start = shown;
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = clamp(Number((start + Math.round(ev.clientX - startX) * step).toFixed(precision)));
      setDraft(String(latest));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (latest !== start) onCommit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <label className="group relative flex h-8 items-center rounded-lg border border-input bg-transparent text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      <span
        onPointerDown={startScrub}
        className="flex h-full w-7 shrink-0 cursor-ew-resize items-center justify-center text-[11px] font-medium text-muted-foreground select-none"
      >
        {label}
      </span>
      <Input
        value={draft ?? String(shown)}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onCommit(clamp(Number((shown + d).toFixed(precision))));
          }
        }}
        className="h-full min-w-0 border-0 bg-transparent px-0 tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {suffix && <span className="pr-2 text-xs text-muted-foreground">{suffix}</span>}
    </label>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function ColorField({
  value,
  onCommit,
  label,
}: {
  value: string;
  onCommit: (hex: string) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const six = value.slice(0, 7).toUpperCase();
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-input px-1.5 text-sm dark:bg-input/30">
      <label className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-border">
        {/* 色块显示的是用户选的文档颜色（数据），故走内联样式 */}
        <span className="absolute inset-0" style={{ background: six }} />
        <input
          type="color"
          value={six}
          aria-label={label ?? "颜色"}
          onChange={(e) => onCommit(e.target.value.toUpperCase())}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <input
        value={draft ?? six}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          setDraft(null);
          const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
          if (HEX.test(v) && v.toUpperCase() !== six) onCommit(v.toUpperCase());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none"
        aria-label={`${label ?? "颜色"}色值`}
      />
    </div>
  );
}
