import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { AgentMode } from "@/lib/api";

/**
 * 会话模式切换器（样式对齐 PermissionSwitcher / ModelSwitcher）：置于输入框工具条最前，下一轮运行生效。
 * 选项 = 通用（null）+ 用户的模式；运行中 / 等审批时由调用方 disabled（agent-host 也会拒绝）。
 */
export function ModeSwitcher({
  value,
  modes,
  onChange,
  disabled,
}: {
  /** 当前会话的模式 id；null = 通用 */
  value: string | null;
  modes: AgentMode[];
  onChange: (modeId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = value ? modes.find((m) => m.id === value) : undefined;
  // 模式被删了（会话上残留 id）：按通用显示，与 agent-host 的运行口径一致
  const label = current?.name ?? t("chat.mode.general");
  const options: { id: string | null; name: string; hint: string }[] = [
    { id: null, name: t("chat.mode.general"), hint: t("chat.mode.generalHint") },
    ...modes.map((m) => ({
      id: m.id,
      name: m.name,
      hint: t("chat.mode.summary", {
        tools: m.toolNames.length,
        servers: m.mcpServerIds.length,
        skills: m.skillNames.length,
      }),
    })),
  ];

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.mode.button", { label })}
        onClick={() => setOpen((v) => !v)}
        className="max-w-40 text-muted-foreground hover:text-foreground"
      >
        <SlidersHorizontal />
        <span className="truncate">{label}</span>
        <ChevronDown className="opacity-60" />
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
            aria-label={t("chat.mode.list")}
            className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-80 overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-lg"
          >
            {options.map((o) => {
              const active = o.id === (current?.id ?? null);
              return (
                <button
                  key={o.id ?? "general"}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                    active ? "bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <Check className={`size-3.5 shrink-0 ${active ? "opacity-100" : "opacity-0"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{o.name}</span>
                    <span className="block text-xs text-muted-foreground">{o.hint}</span>
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
