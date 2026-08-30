"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 默认文案。第 0 条固定用作首帧（SSR 与水合必须一致，随机只在客户端 interval 里发生）。
 * 业务侧要按 agent 阶段换措辞时用 phrases prop 覆盖。
 */
const DEFAULT_PHRASES = [
  "Thinking",
  "Wiring up the nodes",
  "Consulting the canvas",
  "Untangling the edges",
  "Rummaging through tools",
  "Plotting a route",
  "Doing the clever bit",
  "Herding the boxes",
  "Connecting the dots",
  "Sketching it out",
  "Measuring twice",
  "Chasing a better idea",
] as const;

const ROTATE_MS = 2600;

/** 方格的动画方式，具体 delay 编排见 globals.css 的 [data-thinking-anim] 规则。 */
export type ThinkingAnimation =
  /** 9 格错峰脉动，各格周期互不相同、读起来是忙碌（默认）；与 standby 的整体呼吸相对 */
  | "pulse"
  /** 沿主对角线推进的斜向波 */
  | "wave"
  /** 外圈 8 格顺时针依次点亮，中心格常亮当轴 */
  | "orbit"
  /** 待机灯：4.5s 一口气的缓慢呼吸，自中心向外漫开、逐格亮度不同。
   *  给「空闲但随时可唤醒」的常驻展示用 */
  | "standby";

/**
 * 3×3 脉动方阵本体（不含文案）。`--tt-size` 与 `data-thinking-anim` 都挂在方阵自己身上：
 * 方阵是 9 个格子的祖先，globals.css 里 `[data-thinking-anim=…] .canvas-thinking-cell`
 * 的选择器照常命中，因此它可以脱离 CanvasThinkingIndicator 单独用（如收起态的触发按钮）。
 */
export function ThinkingGrid({
  size = 24,
  color,
  animation = "pulse",
  className,
}: {
  size?: number;
  color?: string;
  animation?: ThinkingAnimation;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("canvas-thinking-grid", className)}
      // CSS 自定义属性不在 CSSProperties 的键里，只能整体断言（值本身仍是强类型的 string）
      style={
        {
          "--tt-size": `${size}px`,
          ...(color ? { "--thinking-cell": color } : {}),
        } as React.CSSProperties
      }
      data-thinking-anim={animation}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="canvas-thinking-cell" />
      ))}
    </span>
  );
}

/**
 * 文案轮换：每 ROTATE_MS 在「除当前项外的 n-1 项」里均匀取一个，保证不连着重复同一句。
 * 返回下标而不是字符串——退场动画要靠 key 区分新旧两条，字符串在跨阶段切换时可能撞车。
 * 首帧固定第 0 条（SSR 与水合必须一致，随机只发生在客户端 interval 里）。
 */
export function useRotatingPhrase(count: number): {
  current: number;
  previous: number | null;
} {
  // previous 只为播退场动画而留：没有它，旧词会被直接卸载，中间空一帧
  const [slot, setSlot] = useState<{ current: number; previous: number | null }>(
    { current: 0, previous: null },
  );

  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(() => {
      setSlot((prev) => {
        const pick = Math.floor(Math.random() * (count - 1));
        const next = pick >= prev.current ? pick + 1 : pick;
        return { current: next, previous: prev.current };
      });
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [count]);

  return slot;
}

export interface CanvasThinkingIndicatorProps {
  /** 整体边长（px），方阵、间距、字号、光晕、圆点全部按它等比缩放。默认 24。 */
  size?: number;
  /**
   * 方格颜色，任意 CSS 颜色值。光晕从它派生，所以只需给这一个。
   * 不传则跟随主题（亮/暗各一套鲜亮金橙，见 globals.css 的 --thinking-cell）。
   */
  color?: string;
  /** 方格动画方式，默认 "pulse"。 */
  animation?: ThinkingAnimation;
  /** 轮换文案，至少一条。默认是一组通用的「思考中」措辞。 */
  phrases?: readonly string[];
  className?: string;
}

/**
 * 画布 agent「思考中」指示器：3×3 方格按选定方式脉动 + 同色方形柔光晕，
 * 右侧配随机轮换的文案。用在已发出请求、但模型还没开始吐内容的空窗期
 * （有 reasoning / assistant / tool 在流式产出时就不该再显示它）。
 *
 * 动效与尺寸换算全在 CSS（globals.css 的 .canvas-thinking*），组件只负责换文案和透传 props。
 */
export function CanvasThinkingIndicator({
  size = 24,
  color,
  animation = "pulse",
  phrases = DEFAULT_PHRASES,
  className,
}: CanvasThinkingIndicatorProps) {
  const { current, previous } = useRotatingPhrase(phrases.length);

  return (
    <div
      className={cn("canvas-thinking", className)}
      // 外层只用 --tt-size 换算 gap / padding / 字号；方阵自带同一份尺寸与动画属性
      style={{ "--tt-size": `${size}px` } as React.CSSProperties}
      role="status"
      aria-live="polite"
    >
      <ThinkingGrid size={size} color={color} animation={animation} />

      {/* key 让每次换词都重挂载，进/出场动画随之重播 */}
      <span className="canvas-thinking-phrase font-medium text-foreground">
        {previous !== null && previous !== current && (
          <span
            key={`out-${previous}`}
            aria-hidden
            className="canvas-thinking-phrase-out"
          >
            {phrases[previous] ?? ""}
          </span>
        )}
        <span key={`in-${current}`} className="canvas-thinking-phrase-in">
          {phrases[current] ?? phrases[0]}
        </span>
      </span>
    </div>
  );
}
