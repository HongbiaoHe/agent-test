"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { ThemeSetting } from "../_hooks/use-theme";

const META: Record<
  ThemeSetting,
  { Icon: typeof Monitor; label: string; next: string }
> = {
  system: { Icon: Monitor, label: "跟随系统", next: "浅色" },
  light: { Icon: Sun, label: "浅色", next: "暗色" },
  dark: { Icon: Moon, label: "暗色", next: "跟随系统" },
};

/**
 * 三档循环：系统 → 亮 → 暗。theme 未水合时（undefined）按"跟随系统"占位渲染，
 * 与 SSR 一致；水合后切到真实档位。
 */
export function ThemeToggle({
  theme,
  onCycle,
}: {
  theme?: ThemeSetting;
  onCycle: () => void;
}) {
  const { Icon, label, next } = META[theme ?? "system"];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`主题：${label}，点击切换到${next}`}
            onClick={onCycle}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>
        {label} · 点击切到{next}
      </TooltipContent>
    </Tooltip>
  );
}
