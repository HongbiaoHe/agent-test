"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { ThemeSetting } from "../_hooks/use-theme";

const META: Record<
  ThemeSetting,
  { Icon: typeof Sun; label: string; next: string }
> = {
  light: { Icon: Sun, label: "Light", next: "Dark" },
  dark: { Icon: Moon, label: "Dark", next: "Light" },
};

/**
 * 两档切换：亮 ⇄ 暗。theme 未水合时（undefined）按 light 占位渲染，
 * 与 SSR 一致；水合后切到真实档位。
 */
export function ThemeToggle({
  theme,
  onCycle,
}: {
  theme?: ThemeSetting;
  onCycle: () => void;
}) {
  const { Icon, label, next } = META[theme ?? "light"];
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
