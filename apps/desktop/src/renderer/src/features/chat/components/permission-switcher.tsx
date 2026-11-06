import { Check, ChevronDown, Eye, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import {
  WORKSPACE_PERMISSIONS,
  type WorkspacePermission,
} from "../../../../../shared/workspace";

const PERMISSION_ICON = { read_only: Eye, ask: ShieldCheck, auto: Zap } as const;

/**
 * 会话权限档位切换器（桌面端独有，样式对齐 ModelSwitcher）：置于输入框工具条，下一轮运行生效。
 * 下拉用 backdrop 处理外部点击关闭，与 ModelSwitcher 同一写法。
 */
export function PermissionSwitcher({
  value,
  onChange,
  disabled,
}: {
  value: WorkspacePermission;
  onChange: (permission: WorkspacePermission) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = PERMISSION_ICON[value];
  const label = t(`chat.permission.label.${value}`);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.permission.button", { label })}
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Icon />
        <span>{label}</span>
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
            aria-label={t("chat.permission.list")}
            className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border bg-popover p-1.5 shadow-lg"
          >
            {WORKSPACE_PERMISSIONS.map((p) => {
              const active = p === value;
              const ItemIcon = PERMISSION_ICON[p];
              return (
                <button
                  key={p}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                    active ? "bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <Check className={`size-3.5 shrink-0 ${active ? "opacity-100" : "opacity-0"}`} />
                  <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`chat.permission.label.${p}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`chat.permission.hint.${p}`)}</span>
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
