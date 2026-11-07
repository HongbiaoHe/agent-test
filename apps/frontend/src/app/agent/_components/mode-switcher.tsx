"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Settings2, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { MODES_QUERY_KEY } from "@/app/settings/modes/_components/mode-list";
import { Button } from "@/components/ui/button";
import { type AgentMode, listModes } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 通用模式的展示名（modeId = null）。 */
export const GENERAL_MODE_LABEL = "General";

function modeHint(m: AgentMode): string {
  return `${m.toolNames.length} tools · ${m.mcpServerIds.length} connectors · ${m.skillNames.length} skills`;
}

/**
 * 会话模式切换器：紧凑下拉，置于输入框工具条最左。
 * 选项 = General（通用模式，全部工具 / 连接器 / 技能）+ 用户的模式列表；底部进设置页管理。
 * 下拉用 backdrop 处理外部点击关闭（与 ModelSwitcher 同范式，不在 effect 里 setState）。
 * 运行中由外部传 disabled（后端对 running / waiting_approval 会话的切换返回 409）。
 */
export function ModeSwitcher({
  value,
  onChange,
  disabled,
}: {
  /** 当前模式 id；null = 通用模式 */
  value: string | null;
  onChange: (modeId: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: modes = [] } = useQuery({
    queryKey: MODES_QUERY_KEY,
    queryFn: listModes,
    staleTime: 60_000,
  });
  const current = value ? modes.find((m) => m.id === value) : undefined;
  const label = current?.name ?? GENERAL_MODE_LABEL;

  const options: { id: string | null; name: string; hint: string }[] = [
    { id: null, name: GENERAL_MODE_LABEL, hint: "All tools, connectors and skills" },
    ...modes.map((m) => ({ id: m.id, name: m.name, hint: modeHint(m) })),
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
        aria-label="Conversation mode"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground"
      >
        <SlidersHorizontal />
        <span className="max-w-40 truncate">{label}</span>
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
          <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border bg-popover p-1.5 shadow-lg">
            <div role="listbox" aria-label="Conversation mode" className="max-h-72 overflow-y-auto">
              {options.map((o) => {
                const active = o.id === value;
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
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent",
                      active && "bg-accent",
                    )}
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{o.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {o.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-1 border-t pt-1">
              <Link
                href="/settings/modes"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Settings2 className="size-3.5" />
                Manage modes
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
