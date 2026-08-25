"use client";

import { Brain, Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  type ThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from "../_lib/models";

/**
 * 思考深度切换器：紧凑下拉，紧邻模型切换器。
 *
 * 可选档位**按当前模型动态给**——DeepSeek 只有开/关，Gemini 才有低/中/高（后端实测：OpenAI 风格
 * 的 reasoningEffort 对 DeepSeek 无效）。不给点了没反应的假选项，所以这里依赖 model prop。
 *
 * 用 backdrop 处理外部点击关闭（不在 effect 里 setState，规避 Next16 的
 * react-hooks/set-state-in-effect），与 CanvasModelSwitcher 一致。
 */
export function CanvasThinkingSwitcher({
  model,
  value,
  onChange,
  disabled,
}: {
  model: string;
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = thinkingLevelsFor(model);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Thinking depth"
        onClick={() => setOpen((v) => !v)}
        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3.5" />
        <span className="max-w-24 truncate">{thinkingLevelLabel(value)}</span>
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
            /* 右对齐向左展开：本切换器紧贴模型切换器右侧，left-0 会让面板溢出聊天栏被裁掉 */
            className="absolute bottom-full right-0 z-50 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value);
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
                      active ? "text-primary opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {o.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.hint}
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
