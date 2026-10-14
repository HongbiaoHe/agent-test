"use client";

import { Check, ChevronDown, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";

import type { CanvasApprovalMode } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * 敏感操作的审批模式切换器：紧邻模型 / 思考深度切换器，同一套紧凑下拉。
 *
 * 只有两档，刻意不做成开关（Switch）：这两种模式的差别是「会不会花钱、会不会毁掉画布」，
 * 值得让人看清楚每一档到底意味着什么，而不是猜一个开关的语义。
 *
 * 浮层用 Popover（Portal + 碰撞避让）：工具栏会随宽度换行，手写 absolute 定位在某种布局下
 * 必然被聊天栏裁掉（见 CanvasThinkingSwitcher）。
 */
const OPTIONS: {
  value: CanvasApprovalMode;
  label: string;
  hint: string;
  Icon: typeof ShieldCheck;
}[] = [
  {
    value: "review",
    label: "Ask before risky steps",
    hint: "清空画布、触发生成前先问你；需要澄清时会等你回答",
    Icon: ShieldCheck,
  },
  {
    value: "auto",
    label: "Full autopilot",
    hint: "全程不打断，按 agent 的判断直接执行——包括清空与生成",
    Icon: Zap,
  },
];

export function CanvasApprovalSwitcher({
  value,
  onChange,
  disabled,
}: {
  value: CanvasApprovalMode;
  onChange: (mode: CanvasApprovalMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];
  const auto = value === "auto";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Approval mode"
            className={cn(
              "h-8 gap-1.5 px-2 text-xs data-popup-open:bg-accent",
              // 全自动会自己花钱、自己清空画布，值得一直显眼地提示着，而不是缩成一枚灰图标
              auto
                ? "text-warning hover:text-warning"
                : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <current.Icon className="size-3.5" />
        <span className="max-w-24 truncate">{auto ? "Auto" : "Review"}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      {/* Portal 渲染到 body：不受聊天栏 overflow 裁剪；工具栏 flex-wrap 换行后位置会变，
          由 Positioner 的碰撞避让自动挪回可视区（左对齐向上，与模型 / 技能选择一致） */}
      <PopoverContent side="top" align="start" className="w-72 p-1.5">
        <div role="listbox" aria-label="Approval mode">
            {OPTIONS.map((o) => {
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
                    <span className="block text-xs text-muted-foreground">
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
