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
  system: { Icon: Monitor, label: "System", next: "Light" },
  light: { Icon: Sun, label: "Light", next: "Dark" },
  dark: { Icon: Moon, label: "Dark", next: "System" },
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
            aria-label={`Theme: ${label}. Click to switch to ${next}`}
            onClick={onCycle}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>
        {label} · click to switch to {next}
      </TooltipContent>
    </Tooltip>
  );
}
