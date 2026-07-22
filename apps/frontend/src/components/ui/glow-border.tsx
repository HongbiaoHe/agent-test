import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * 旋转高光渐变边框容器：两段对称柔光沿边框环缓慢旋转，吸引用户注意需强调/响应的内容。
 *
 * 用法 —— 把要强调的内容放进来即可，自带圆角边框环（无静态 border）：
 *   <GlowBorder className="bg-card p-4">…</GlowBorder>
 *
 * - 圆角默认 rounded-xl，可用 className 覆盖（::before 边框环按 border-radius 自动跟随）。
 * - 背景 / 内边距 / 阴影等由调用方经 className 提供（不同场景各异，组件不预设）。
 * - 旋转速度、边框宽度、高光色可经 CSS 变量覆盖：
 *     style={{ "--glow-speed": "5s", "--glow-width": "2px", "--glow-color": "var(--ring)" }}
 * - 动画尊重 prefers-reduced-motion；视觉实现见 globals.css 的 .glow-border。
 */
export function GlowBorder({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("glow-border rounded-xl", className)} {...props}>
      {children}
    </div>
  );
}
