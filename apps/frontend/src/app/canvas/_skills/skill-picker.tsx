"use client";

import { Lock, Search, Settings2, Slash, Wand2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CanvasSkillInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 输入框工具条上的「技能」入口：不记得名字、或者不知道有哪些技能时，点开挑一个。
 * 选中 = 把 `/技能名 ` 放到输入框开头（与手敲 `/` 补全同一个结果），底部可进管理面板。
 */
export function SkillPicker({
  skills,
  disabled,
  onPick,
  onManage,
}: {
  /** 只给启用的 */
  skills: CanvasSkillInfo[];
  disabled?: boolean;
  onPick: (name: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = query
    ? skills.filter(
        (s) =>
          s.name.includes(query) ||
          s.description.toLowerCase().includes(query),
      )
    : skills;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Skills"
            title="Skills"
            // 只放图标：这一排还挤着模型 / 思考 / 审批三个切换器，聊天面板又窄
            className="size-8 px-0 text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
          />
        }
      >
        <Wand2 className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a skill"
            aria-label="Find a skill"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {shown.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {skills.length === 0 ? "No skills yet" : "No matching skills"}
            </p>
          ) : (
            shown.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  onPick(s.name);
                  setOpen(false);
                  setQ("");
                }}
                className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <Slash
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm text-foreground">
                    <span className="truncate font-medium">{s.name}</span>
                    {s.kind === "builtin" && (
                      <Lock
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label="Built-in"
                      />
                    )}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onManage();
          }}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          )}
        >
          <Settings2 className="size-3.5" />
          Manage skills
        </button>
      </PopoverContent>
    </Popover>
  );
}
