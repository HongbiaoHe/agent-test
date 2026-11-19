"use client";

import { Check, ChevronDown, Cpu, Search, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { useModelOptions } from "../../llm/api";
import { filterModels, groupByConnection, modelIdOfRef } from "../../llm/model-options";

/**
 * 回答模型切换器：紧凑下拉，置于输入框工具条左侧。选项是当前账号已启用的模型（设置 → 模型），
 * 按连接分组、可搜索；值是模型引用「连接 id/模型 id」。
 * 会话存的模型不在已启用模型里（停用 / 连接已删）时标「不可用」——host 下一轮会回落到默认模型并提示。
 * 浮层用 Popover（Portal + 碰撞避让），同思考深度切换器。
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useModelOptions();
  const list = options.data ?? [];
  const groups = groupByConnection(filterModels(list, query));
  const unavailable = !!value && !!options.data && !list.some((m) => m.ref === value);
  const label = modelIdOfRef(value) || t("chat.modelSwitcher.none");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t("chat.modelSwitcher.button", { model: label })}
            title={unavailable ? t("chat.modelSwitcher.unavailableHint") : undefined}
            className={cn(
              "text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
              unavailable && "text-destructive hover:text-destructive",
            )}
          />
        }
      >
        {unavailable ? <TriangleAlert /> : <Cpu />}
        <span className="max-w-56 truncate font-mono">{label}</span>
        {unavailable && <span>· {t("chat.modelSwitcher.unavailable")}</span>}
        <ChevronDown className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b p-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("chat.modelSwitcher.search")}
              aria-label={t("chat.modelSwitcher.search")}
              className="h-8 border-0 pl-8 shadow-none focus-visible:ring-0 dark:bg-transparent"
              autoFocus
            />
          </div>
        </div>
        {/* 原生滚动：模型可能有上百个（OpenRouter） */}
        <div role="listbox" aria-label={t("chat.modelSwitcher.list")} className="max-h-72 overflow-y-auto p-1.5">
          {unavailable && (
            <p className="px-2 py-1.5 text-xs text-destructive">{t("chat.modelSwitcher.unavailableHint")}</p>
          )}
          {list.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">{t("chat.modelSwitcher.empty")}</p>
          ) : groups.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">{t("chat.modelSwitcher.noMatch")}</p>
          ) : (
            groups.map((g) => (
              <div key={g.connectionId} role="group" aria-label={g.connectionName}>
                <div className="truncate px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {g.connectionName}
                </div>
                {g.models.map((m) => {
                  const active = m.ref === value;
                  return (
                    <button
                      key={m.ref}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(m.ref);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                        active ? "bg-accent" : "hover:bg-accent",
                      )}
                    >
                      <Check className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm font-medium">{m.modelId}</span>
                        {m.displayName && m.displayName !== m.modelId && (
                          <span className="block truncate text-xs text-muted-foreground">{m.displayName}</span>
                        )}
                      </span>
                      {m.test?.status === "no_tools" && (
                        <span
                          role="img"
                          aria-label={t("chat.modelSwitcher.noTools")}
                          title={t("chat.modelSwitcher.noTools")}
                          className="shrink-0 text-warning"
                        >
                          <TriangleAlert className="size-3.5" />
                        </span>
                      )}
                      {m.listState === "missing" && (
                        <Badge variant="destructive">{t("chat.modelSwitcher.missing")}</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
