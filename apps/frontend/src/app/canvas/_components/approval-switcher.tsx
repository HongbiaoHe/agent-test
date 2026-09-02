"use client";

import { Check, ChevronDown, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";

import type { CanvasApprovalMode } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 敏感操作的审批模式切换器：紧邻模型 / 思考深度切换器，同一套紧凑下拉。
 *
 * 只有两档，刻意不做成开关（Switch）：这两种模式的差别是「会不会花钱、会不会毁掉画布」，
 * 值得让人看清楚每一档到底意味着什么，而不是猜一个开关的语义。
 *
 * 用 backdrop 处理外部点击关闭（不在 effect 里 setState，规避 Next16 的
 * react-hooks/set-state-in-effect），与另外两个切换器一致。
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
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Approval mode"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "h-8 gap-1.5 px-2 text-xs",
          // 全自动会自己花钱、自己清空画布，值得一直显眼地提示着，而不是缩成一枚灰图标
          auto
            ? "text-warning hover:text-warning"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <current.Icon className="size-3.5" />
        <span className="max-w-24 truncate">{auto ? "Auto" : "Review"}</span>
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
            /* 右对齐向左展开：紧贴前一个切换器右侧，left-0 会让面板溢出聊天栏被裁掉 */
            className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          >
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
        </>
      )}
    </div>
  );
}
