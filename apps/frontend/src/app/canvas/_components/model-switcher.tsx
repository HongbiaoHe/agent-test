"use client";

import { AlertTriangle, Check, ChevronDown, Cpu } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  CANVAS_MODEL_OPTIONS,
  type CanvasModelCaps,
  canvasModelLabel,
} from "../_lib/models";

/**
 * 模型实测能力说明（hover 选项时贴在右侧）。数据与来源见 _lib/models.ts 的 CanvasModelCaps。
 * tooltip 走 surface 变体（与下拉同为 popover 底），所以这里用常规语义色即可。
 */
function ModelCapsCard({ caps }: { caps: CanvasModelCaps }) {
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Prompt cache
        </span>
        <span className="text-foreground">{caps.cache}</span>
      </span>
      <span className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Thinking depth
        </span>
        <span className="text-foreground">{caps.thinking}</span>
      </span>
      {caps.notes?.length ? (
        <span className="flex flex-col gap-1 border-t border-border pt-1.5">
          {caps.notes.map((n) => (
            <span key={n} className="flex items-start gap-1.5 text-foreground">
              <AlertTriangle className="mt-px size-3 shrink-0 text-warning" />
              <span>{n}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

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
                <Tooltip key={m.value}>
                  <TooltipTrigger
                    render={
                      <button
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
                      />
                    }
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
                  </TooltipTrigger>
                  {/* 贴在选项右侧：下拉本身向上展开，右侧才有稳定空间 */}
                  <TooltipContent
                    side="right"
                    sideOffset={10}
                    variant="surface"
                    className="max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
                  >
                    <ModelCapsCard caps={m.caps} />
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
