"use client";

import { Check, ChevronDown, Cpu } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { MODEL_OPTIONS } from "../_lib/models";

/**
 * 回答模型切换器：紧凑下拉，置于输入框工具条左侧。
 * 选中的模型由 AgentShell 持有，发消息时随 create/append 一并带给后端。
 * 下拉用 backdrop 处理外部点击关闭（不在 effect 里 setState，规避 Next16 lint）。
 */
export function ModelSwitcher({
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
        size="xs"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Cpu />
        <span className="max-w-56 truncate font-mono">{value}</span>
        <ChevronDown className="opacity-60" />
      </Button>

      {open && (
        <>
          {/* 点击空白处关闭 */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-lg"
          >
            {MODEL_OPTIONS.map((m) => {
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
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                    active ? "bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <Check
                    className={`size-3.5 shrink-0 ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm font-medium">
                      {m.value}
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
