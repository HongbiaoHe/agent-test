"use client";

import { Lock, Slash } from "lucide-react";
import { useEffect, useRef } from "react";

import type { CanvasSkillInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 输入 `/` 时浮在输入框上方的技能补全。键盘由输入框驱动（↑↓ 选、Enter/Tab 确认、Esc 关），
 * 这里只负责展示与鼠标点选。
 *
 * 高亮项滚进视野用的是列表自己的 scrollTop，而不是 scrollIntoView——后者会顺带滚动每一个可滚祖先，
 * 画布页外壳因此被整体顶上去（见 agent-shell 的 overflow-clip 教训）。
 */
export function SkillCommandMenu({
  skills,
  activeIndex,
  onPick,
  onHover,
}: {
  skills: CanvasSkillInfo[];
  activeIndex: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Skills"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {skills.map((s, i) => (
        <button
          key={s.name}
          type="button"
          role="option"
          data-index={i}
          aria-selected={i === activeIndex}
          // mousedown 而不是 click：避免输入框先失焦、菜单在点中之前就收起
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s.name);
          }}
          onMouseMove={() => onHover(i)}
          className={cn(
            "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left",
            i === activeIndex && "bg-accent",
          )}
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
            <span className="line-clamp-1 text-xs text-muted-foreground">
              {s.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
