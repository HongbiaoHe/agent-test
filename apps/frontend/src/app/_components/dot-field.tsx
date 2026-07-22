"use client";

import { memo, useEffect, useRef } from "react";

const TWO_PI = Math.PI * 2;

/** 单个点：a* 为原始锚点，s* 为当前绘制位置（带阻尼回弹），用于光标 bulge。 */
interface Dot {
  ax: number;
  ay: number;
  sx: number;
  sy: number;
}

interface CanvasSize {
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
}

interface MouseState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  speed: number;
}

/** 点阵配色（从 globals.css 的 --dotfield-* token 读出，随亮/暗主题切换重读）。 */
interface Palette {
  from: string;
  to: string;
}

/** 每帧读取的可调参数 + 实时配色，存 ref 避免重启动画。 */
interface RuntimeConfig {
  dotRadius: number;
  dotSpacing: number;
  cursorRadius: number;
  bulgeStrength: number;
  sparkle: boolean;
  waveAmplitude: number;
  palette: Palette;
}

export interface DotFieldProps {
  /** 单点直径基准（实际绘制半径为其一半） */
  dotRadius?: number;
  /** 点间距 */
  dotSpacing?: number;
  /** 光标交互半径 */
  cursorRadius?: number;
  /** 光标处点阵外凸强度 */
  bulgeStrength?: number;
  /** 开启后约 3% 的点随机放大闪烁 */
  sparkle?: boolean;
  /** 整体波动位移幅度，0 为静止 */
  waveAmplitude?: number;
  className?: string;
}

/** 读取当前主题下的点阵配色 token（oklch 字符串，canvas 直接消费）。 */
function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  return {
    from: s.getPropertyValue("--dotfield-dot-from").trim(),
    to: s.getPropertyValue("--dotfield-dot-to").trim(),
  };
}

/**
 * 交互式点阵背景（移植自 React Bits DotField）。
 *
 * 与原版差异（适配本项目）：
 * - 配色不再走 props，统一从设计系统 token（--dotfield-*）读取，亮/暗自动切换（CLAUDE.md §7）；
 * - 仅保留 bulge（光标外凸）模式，去掉用不到的物理推力分支（§2 最小实现）；
 * - 去掉光标跟随的径向柔光（按需求不展示），只留点阵本体；
 * - 尊重 prefers-reduced-motion：开启时只静态铺一次点，不跑动画 / 不绑光标。
 *
 * 全程只操作 ref 与 canvas，不在 effect 里 setState（避免 set-state-in-effect）。
 */
const DotField = memo(function DotField({
  dotRadius = 2.6,
  dotSpacing = 18,
  cursorRadius = 350,
  bulgeStrength = 42,
  sparkle = true,
  waveAmplitude = 4,
  className,
}: DotFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cfgRef = useRef<RuntimeConfig>({
    dotRadius,
    dotSpacing,
    cursorRadius,
    bulgeStrength,
    sparkle,
    waveAmplitude,
    palette: { from: "", to: "" },
  });
  cfgRef.current = {
    dotRadius,
    dotSpacing,
    cursorRadius,
    bulgeStrength,
    sparkle,
    waveAmplitude,
    palette: cfgRef.current.palette,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dots: Dot[] = [];
    const mouse: MouseState = {
      x: -9999,
      y: -9999,
      prevX: -9999,
      prevY: -9999,
      speed: 0,
    };
    const size: CanvasSize = { w: 0, h: 0, offsetX: 0, offsetY: 0 };
    let engagement = 0;
    let frameCount = 0;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    function syncPalette() {
      cfgRef.current.palette = readPalette();
    }

    function buildDots(w: number, h: number) {
      const { dotRadius: r, dotSpacing: gap } = cfgRef.current;
      const step = r + gap;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      dots.length = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2;
          const ay = padY + row * step + step / 2;
          dots.push({ ax, ay, sx: ax, sy: ay });
        }
      }
    }

    function doResize() {
      const rect = parent!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      size.w = w;
      size.h = h;
      size.offsetX = rect.left + window.scrollX;
      size.offsetY = rect.top + window.scrollY;
      buildDots(w, h);
    }

    /** 静态铺一次点（reduced-motion 用，无交互无动画）。 */
    function drawStatic() {
      const { palette, dotRadius: r } = cfgRef.current;
      const rad = r / 2;
      ctx!.clearRect(0, 0, size.w, size.h);
      const grad = ctx!.createLinearGradient(0, 0, size.w, size.h);
      grad.addColorStop(0, palette.from);
      grad.addColorStop(1, palette.to);
      ctx!.fillStyle = grad;
      ctx!.beginPath();
      for (const d of dots) {
        ctx!.moveTo(d.ax + rad, d.ay);
        ctx!.arc(d.ax, d.ay, rad, 0, TWO_PI);
      }
      ctx!.fill();
    }

    function onMouseMove(e: MouseEvent) {
      mouse.x = e.pageX - size.offsetX;
      mouse.y = e.pageY - size.offsetY;
    }

    function updateMouseSpeed() {
      const dx = mouse.prevX - mouse.x;
      const dy = mouse.prevY - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      mouse.speed += (dist - mouse.speed) * 0.5;
      if (mouse.speed < 0.001) mouse.speed = 0;
      mouse.prevX = mouse.x;
      mouse.prevY = mouse.y;
    }

    let rafId = 0;

    function tick() {
      frameCount++;
      const cfg = cfgRef.current;
      const { palette } = cfg;
      const t = frameCount * 0.02;

      const targetEngagement = Math.min(mouse.speed / 5, 1);
      engagement += (targetEngagement - engagement) * 0.06;
      if (engagement < 0.001) engagement = 0;
      const eng = engagement;

      ctx!.clearRect(0, 0, size.w, size.h);
      const grad = ctx!.createLinearGradient(0, 0, size.w, size.h);
      grad.addColorStop(0, palette.from);
      grad.addColorStop(1, palette.to);
      ctx!.fillStyle = grad;

      const cr = cfg.cursorRadius;
      const crSq = cr * cr;
      const rad = cfg.dotRadius / 2;

      ctx!.beginPath();
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const dx = mouse.x - d.ax;
        const dy = mouse.y - d.ay;
        const distSq = dx * dx + dy * dy;

        if (distSq < crSq && eng > 0.01) {
          const dist = Math.sqrt(distSq);
          const k = 1 - dist / cr;
          const push = k * k * cfg.bulgeStrength * eng;
          const angle = Math.atan2(dy, dx);
          d.sx += (d.ax - Math.cos(angle) * push - d.sx) * 0.15;
          d.sy += (d.ay - Math.sin(angle) * push - d.sy) * 0.15;
        } else {
          d.sx += (d.ax - d.sx) * 0.1;
          d.sy += (d.ay - d.sy) * 0.1;
        }

        let drawX = d.sx;
        let drawY = d.sy;
        if (cfg.waveAmplitude > 0) {
          drawY += Math.sin(d.ax * 0.03 + t) * cfg.waveAmplitude;
          drawX += Math.cos(d.ay * 0.03 + t * 0.7) * cfg.waveAmplitude * 0.5;
        }

        if (cfg.sparkle) {
          const hash = ((i * 2654435761) ^ (frameCount >> 3)) >>> 0;
          const r = hash % 100 < 3 ? rad * 1.8 : rad;
          ctx!.moveTo(drawX + r, drawY);
          ctx!.arc(drawX, drawY, r, 0, TWO_PI);
        } else {
          ctx!.moveTo(drawX + rad, drawY);
          ctx!.arc(drawX, drawY, rad, 0, TWO_PI);
        }
      }
      ctx!.fill();

      rafId = requestAnimationFrame(tick);
    }

    syncPalette();
    doResize();
    // 挂载即同步铺一次静态点，不等首个 rAF——避免首帧空白（尤其后台标签页 rAF 被暂停时）。
    drawStatic();
    // canvas 已接管绘制：移除 SSR 阶段的 CSS 点阵占位背景，避免与 canvas 点叠加。
    parent.style.backgroundImage = "none";

    // 主题切换：<html> 的 class 变化时重读配色 token（next-themes 挂/摘 .dark）。
    const themeObserver = new MutationObserver(syncPalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // 跟随父容器尺寸：挂载时父容器可能还没拿到宽度（如视口/容器初始测得 0，
    // 只建出 1 列点），拿到真实尺寸后 ResizeObserver 会再触发并重建点阵——
    // 比只监听 window resize 健壮（后者在这种初始 0 宽场景下未必触发）。
    const resizeObserver = new ResizeObserver(() => {
      doResize();
      drawStatic();
    });
    resizeObserver.observe(parent);

    if (reduceMotion) {
      // 已静态铺过点；reduced-motion 不再起动画 / 不绑光标。
      return () => {
        themeObserver.disconnect();
        resizeObserver.disconnect();
      };
    }

    const speedInterval = setInterval(updateMouseSpeed, 20);
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(speedInterval);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("mousemove", onMouseMove);
    };
    // 只在挂载时建一次；运行期可调参数 / 配色经 cfgRef 读取，无需重启动画。
  }, []);

  return (
    // SSR 友好：用 CSS 点阵作占位背景，首帧（未水合/canvas 未绘制）即有点阵、不白屏；
    // canvas 在客户端首次绘制后会把它清掉（见 effect），实现 SSR → 客户端无缝衔接。
    <div
      className={className}
      aria-hidden="true"
      style={{
        backgroundImage:
          "radial-gradient(var(--dotfield-dot-from) 0.9px, transparent 1px)",
        backgroundSize: "20px 20px",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
    </div>
  );
});

export default DotField;
