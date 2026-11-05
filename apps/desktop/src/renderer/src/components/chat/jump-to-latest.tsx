"use client";

import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 「回到最新」：内容末尾滚出视口时浮在消息流下沿。
 * 这是**唯一**开启「跟随底部」的入口——默认不跟随，回复长出来视图也不动。
 *
 * 需要父级是 `relative`（绝对定位挂在消息区上，不占流内高度、不挤压输入框）。
 */
export function JumpToLatest({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label="Jump to latest"
      onClick={onClick}
      className={cn(
        "absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-md",
        // outline 变体暗色下是 dark:bg-input/30，而 --input 暗色本身就是半透明白
        // （1 0 0 / 12%），叠起来只剩约 3.6% 不透明度 —— 浮在消息流上会透出底下的文字。
        // 浮层该用 popover 面（亮暗都不透明），亮暗两边都显式盖掉变体自带的底色。
        "bg-popover text-popover-foreground hover:bg-accent hover:text-accent-foreground dark:bg-popover dark:hover:bg-accent",
        // 刻意不加入场动画：本项目的内嵌预览里文档常处于 hidden 态，rAF / CSS 动画被暂停，
        // 淡入会冻在中途——按钮看上去半透明甚至不可见。这个按钮是唯一的「回到最新」入口，
        // 不值得为一次淡入冒这个险。
        className,
      )}
    >
      <ArrowDown />
      Latest
    </Button>
  );
}
