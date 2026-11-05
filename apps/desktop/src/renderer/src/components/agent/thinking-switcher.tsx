"use client";

import { Brain, Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  type ThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from "@/lib/thinking-level";

/**
 * 思考深度切换器：紧凑下拉，紧邻模型切换器（画布与 Spark agent 共用）。
 *
 * 可选档位**按当前模型动态给**——DeepSeek 只有开/关，Gemini 才有低/中/高（后端实测：OpenAI 风格
 * 的 reasoningEffort 对 DeepSeek 无效）。不给点了没反应的假选项，所以这里依赖 model prop。
 *
 * 浮层用 Popover（Portal + 碰撞避让）：输入框工具栏会随宽度换行，本切换器有时在模型切换器
 * 右侧、有时换到第二行最左，手写的 absolute 定位总会在某种布局下被聊天栏裁掉。
 */
export function ThinkingSwitcher({
  model,
  value,
  onChange,
  disabled,
  className,
}: {
  model: string;
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /** 触发按钮的尺寸微调（各输入框工具条的按钮高度不同） */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = thinkingLevelsFor(model);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Thinking depth"
            className={cn(
              "h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
              className,
            )}
          />
        }
      >
        <Brain className="size-3.5" />
        <span className="max-w-24 truncate">{thinkingLevelLabel(value)}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      {/* Portal 渲染到 body：不受聊天栏 overflow 裁剪；工具栏 flex-wrap 换行后位置会变，
          由 Positioner 的碰撞避让自动挪回可视区（左对齐向上，与模型 / 技能选择一致） */}
      <PopoverContent side="top" align="start" className="w-64 p-1.5">
        <div role="listbox" aria-label="Thinking depth">
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
      </PopoverContent>
    </Popover>
  );
}
