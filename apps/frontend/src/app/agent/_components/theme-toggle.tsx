"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "light" | "dark";
  onToggle: () => void;
}) {
  const isLight = theme === "light";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isLight ? "切换到暗色" : "切换到浅色"}
            onClick={onToggle}
          />
        }
      >
        {isLight ? <Moon /> : <Sun />}
      </TooltipTrigger>
      <TooltipContent>{isLight ? "切换到暗色" : "切换到浅色"}</TooltipContent>
    </Tooltip>
  );
}
