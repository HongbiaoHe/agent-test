"use client";

import { Check, ChevronDown, Cpu } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { CANVAS_MODEL_OPTIONS, canvasModelLabel } from "../_lib/models";

/**
 * 画布 agent 模型切换器：紧凑下拉，置于输入框工具条左侧。选中的模型随下一条消息带给后端
 * （按会话生效），方便对比不同 Gemini 模型的效果。用 backdrop 处理外部点击关闭（不在 effect 里
 * setState，规避 Next16 lint）。
 */
export function CanvasModelSwitcher({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Cpu className="size-3.5" />
        <span className="max-w-40 truncate">{canvasModelLabel(value)}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </Button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          >
            {CANVAS_MODEL_OPTIONS.map((m) => {
              const active = m.value === value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(m.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                    active ? "bg-accent" : "hover:bg-accent",
                  )}
                >
                  <Check
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "opacity-100 text-primary" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {m.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
