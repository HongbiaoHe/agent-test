"use client";

import {
  cssColor,
  type DesignDocument,
  displayText,
  type Layer,
  nearestFontWeight,
  type TextLayer,
} from "@agent-test/design-schema";
import { AlertTriangle, Loader2, MousePointer2, RotateCw } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { AGENT_ORBIT_MS, type AgentFocus, type AgentWork } from "../../_lib/store";
import { nextWanderStep, type WanderState, type WanderStep } from "./wander";

/** 视图变换：屏幕坐标 = 平移 + 设计稿坐标 × 缩放。 */
export interface View {
  x: number;
  y: number;
  scale: number;
}

/** 让一个 DOM 元素正好盖住图层（含旋转），用于各种覆盖动效。 */
function boxStyle(layer: Pick<Layer, "x" | "y" | "width" | "height" | "rotation">, view: View): CSSProperties {
  return {
    position: "absolute",
    left: view.x + layer.x * view.scale,
    top: view.y + layer.y * view.scale,
    width: layer.width * view.scale,
    height: layer.height * view.scale,
    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
    transformOrigin: "center",
  };
}

/** 画板底：画布底色或透明棋盘格（画在 Konva 透明画布的下面）。 */
export function ArtboardUnderlay({ doc, view }: { doc: DesignDocument; view: View }) {
  const { width, height, background } = doc.canvas;
  const transparent = background === "transparent";
  const cell = Math.max(6, 12 * Math.min(1, view.scale * 2));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute shadow-sm ring-1 ring-border"
      style={{
        left: view.x,
        top: view.y,
        width: width * view.scale,
        height: height * view.scale,
        // 用户选的画布底色是文档数据，不是界面配色，故走内联样式；透明则用 token 的棋盘格
        background: transparent
          ? `repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / ${cell * 2}px ${cell * 2}px`
          : cssColor(background),
      }}
    />
  );
}

/** 画板左上角的尺寸标签；agent 工作时旁边多一枚状态胶囊。 */
export function ArtboardLabel({
  doc,
  view,
  running,
}: {
  doc: DesignDocument;
  view: View;
  running: boolean;
}) {
  return (
    <div
      className="pointer-events-none absolute flex items-center gap-2 text-[11px] font-medium text-muted-foreground tabular-nums"
      style={{ left: view.x, top: view.y - 24 }}
    >
      <span>
        {doc.canvas.width} × {doc.canvas.height}
      </span>
      {running && (
        <span className="flex items-center gap-1.5 text-agent">
          <span className="size-1.5 animate-pulse rounded-full bg-agent motion-reduce:animate-none" />
          Agent 工作中
        </span>
      )}
    </div>
  );
}

/** 生成中：旧图上叠扫光 + 行进虚线框 + 状态标签；失败：错误标签 + 重试。 */
export function GenerationOverlays({
  doc,
  view,
  onRetry,
  orbiting,
}: {
  doc: DesignDocument;
  view: View;
  onRetry: (layerId: string) => void;
  /** 有 agent 光标在绕的图层：光标标签已经写了「生成中」，角标就不重复了 */
  orbiting: Set<string>;
}) {
  return (
    <>
      {doc.layers.map((l) => {
        if (l.type !== "image" || !l.visible) return null;
        if (l.status === "generating") {
          return (
            <div
              key={l.id}
              className={cn(
                "pointer-events-none overflow-hidden rounded-[3px]",
                !l.src && "bg-agent/6",
              )}
              style={boxStyle(l, view)}
            >
              <div className="absolute inset-0 rounded-[3px] border border-dashed border-agent/70" />
              <div className="design-scan absolute inset-y-0 -left-1/2 w-1/2 bg-linear-to-r from-transparent via-background/35 to-transparent" />
              {!orbiting.has(l.id) && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-foreground">
                <Loader2 className="size-3 animate-spin text-agent" />
                {l.generation?.operation === "decompose" ? "拆分中" : "生成中"}
              </div>
              )}
            </div>
          );
        }
        if (l.status === "error") {
          return (
            <div key={l.id} className="pointer-events-none" style={boxStyle(l, view)}>
              <div className="absolute inset-0 rounded-[3px] ring-1 ring-destructive/60" />
              <button
                type="button"
                title={l.generation?.error}
                onClick={() => onRetry(l.id)}
                className="pointer-events-auto absolute top-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-md border border-destructive/30 bg-card px-1.5 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/10"
              >
                <AlertTriangle className="size-3 shrink-0" />
                <span className="truncate">
                  {l.generation?.operation === "decompose" ? "拆分失败" : "生成失败"}
                </span>
                <RotateCw className="size-3 shrink-0" />
              </button>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

/** agent 新加图层的显影扫描。 */
export function AgentOverlays({
  doc,
  view,
  added,
}: {
  doc: DesignDocument;
  view: View;
  added: Record<string, number>;
}) {
  return (
    <>
      {doc.layers.map((l) =>
        added[l.id] ? (
          <div key={l.id} className="pointer-events-none" style={boxStyle(l, view)}>
            <div
              key={added[l.id]}
              className="design-materialize absolute inset-0 rounded-[3px] bg-agent/25"
            />
          </div>
        ) : null,
      )}
    </>
  );
}

/** 同时绕圈的光标上限：一次加十几层时别满屏都是光标 */
const MAX_ORBITS = 8;

/** 光标标签：两三个字说清在干嘛。 */
function workLabel(layer: Layer, action: string): string {
  if (layer.type === "image" && layer.status === "generating") {
    return layer.generation?.operation === "decompose" ? "拆分中" : "创作中";
  }
  if (action.startsWith("添加")) return layer.type === "text" ? "排版" : "放置";
  if (action === "调整层级") return "调层级";
  if (action.startsWith("调整")) return "调整";
  if (action === "查看图层") return "查看";
  return action.slice(0, 6);
}

/**
 * 要绕圈的图层：store 里记着的 agent 活动；agent 运行中且正在生成 / 拆层的图片
 * 即使没有记录（刷新页面后内存记录丢了）也算上，最新的排前面。
 */
export function orbitItems(
  doc: DesignDocument,
  work: Record<string, AgentWork>,
  running: boolean,
): { layer: Layer; w: AgentWork }[] {
  return doc.layers
    .flatMap((layer) => {
      if (!layer.visible) return [];
      const w = work[layer.id];
      if (w) return [{ layer, w }];
      return running && layer.type === "image" && layer.status === "generating"
        ? [{ layer, w: { action: "生成图片", at: 0 } }]
        : [];
    })
    .sort((a, b) => b.w.at - a.w.at)
    .slice(0, MAX_ORBITS);
}

/**
 * agent 正在处理的图层：每个图层一个光标 + 聚焦框。
 * 文字 / 调整类：沿四周转一圈就收（store 到时清掉记录），用 CSS offset-path 不占 JS 帧；
 * 图片生成 / 拆层中：换成随机游走（见 wander.ts），一直走到生成结束。
 */
export function AgentOrbits({
  view,
  items,
}: {
  view: View;
  items: { layer: Layer; w: AgentWork }[];
}) {
  return (
    <>
      {items.map(({ layer, w }, i) => {
        const waiting = layer.type === "image" && layer.status === "generating";
        const glyph = <CursorGlyph label={workLabel(layer, w.action)} rotation={layer.rotation} />;
        return (
          <div
            key={layer.id}
            className="pointer-events-none absolute z-20"
            style={boxStyle(layer, view)}
          >
            <div className="absolute -inset-0.5 rounded-[4px] ring-2 ring-agent" />
            {waiting ? (
              <WanderCursor key={`${layer.id}:wander`} index={i}>
                {glyph}
              </WanderCursor>
            ) : (
              <div className="absolute -inset-2">
                <div
                  key={`${layer.id}:${w.at}`}
                  className="design-orbit absolute top-0 left-0"
                  style={{ animationDuration: `${AGENT_ORBIT_MS}ms` }}
                >
                  {glyph}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** 箭头 + 标签；图层旋转时反向转回来，光标保持正立。 */
function CursorGlyph({ label, rotation }: { label: string; rotation: number }) {
  return (
    <div
      className="flex items-start"
      style={rotation ? { transform: `rotate(${-rotation}deg)` } : undefined}
    >
      <MousePointer2 className="size-4.5 fill-agent text-agent-foreground" strokeWidth={1.5} />
      <span className="mt-3.5 -ml-0.5 rounded-sm bg-agent px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-agent-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * 随机游走的光标：定时取下一个落点（nextWanderStep），用 CSS transition 滑过去，停一会儿再走。
 * 坐标是图层框内的百分比，缩放、平移画布时自然跟着走。减少动态效果时停在左上角不动。
 */
function WanderCursor({ index, children }: { index: number; children: ReactNode }) {
  const [step, setStep] = useState<WanderStep>({ t: 0, u: -0.02, v: -0.02, moveMs: 0, pauseMs: 0 });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cur: WanderState = { t: 0, u: -0.02, v: -0.02 };
    let timer = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        const next = nextWanderStep(cur);
        cur = next;
        setStep(next);
        schedule(next.moveMs + next.pauseMs);
      }, delay);
    };
    // 几个光标同时出现时错开出发
    schedule(120 + index * 230);
    return () => window.clearTimeout(timer);
  }, [index]);
  return (
    <div
      className="absolute"
      style={{
        left: `${step.u * 100}%`,
        top: `${step.v * 100}%`,
        // 箭头尖对准落点
        translate: "-4px -3px",
        transition: `left ${step.moveMs}ms cubic-bezier(0.45, 0.05, 0.25, 1), top ${step.moveMs}ms cubic-bezier(0.45, 0.05, 0.25, 1)`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 没有具体图层可绕时（检查版面、思考）的那个光标：停在画板上方正中。
 * 有图层在被处理时由 AgentOrbits 的光标代言，这里不出现。
 */
export function AgentCursor({
  doc,
  view,
  focus,
  running,
  busy,
}: {
  doc: DesignDocument;
  view: View;
  focus: AgentFocus | null;
  running: boolean;
  busy: boolean;
}) {
  if (!running || busy) return null;
  const x = doc.canvas.width / 2;
  const y = doc.canvas.height * 0.08;
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20"
      style={{ transform: `translate(${view.x + x * view.scale}px, ${view.y + y * view.scale}px)` }}
    >
      <div className="flex items-start">
        <MousePointer2 className="size-4.5 fill-agent text-agent-foreground" strokeWidth={1.5} />
        <span className="mt-3.5 -ml-0.5 rounded-sm bg-agent px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-agent-foreground">
          {focus && !focus.layerIds.length ? focus.action : "思考中"}
        </span>
      </div>
    </div>
  );
}

/** 文字原地编辑：画板上的那份藏起来，原位置盖一个样式一致的 textarea。 */
export function TextEditOverlay({
  layer,
  view,
  onCommit,
}: {
  layer: TextLayer;
  view: View;
  onCommit: (text: string | null) => void;
}) {
  const [value, setValue] = useState(layer.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  // 高度跟随内容
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const s = view.scale;
  const finish = () => onCommit(value === layer.text ? null : value);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
        e.stopPropagation();
      }}
      spellCheck={false}
      className="absolute z-30 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-1 outline-selection outline-dashed"
      style={{
        left: view.x + layer.x * s,
        top: view.y + layer.y * s,
        width: layer.width * s,
        transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
        transformOrigin: "center",
        // 以下都是文档数据（用户选的字体与颜色），按图层原样还原
        fontFamily: `"${layer.fontFamily}"`,
        fontSize: layer.fontSize * s,
        fontWeight: nearestFontWeight(layer.fontFamily, layer.fontWeight),
        fontStyle: layer.fontStyle,
        color: cssColor(layer.fill),
        lineHeight: layer.lineHeight,
        letterSpacing: layer.letterSpacing * s,
        textAlign: layer.align,
        textTransform: layer.textTransform === "uppercase" ? "uppercase" : "none",
        caretColor: "var(--selection)",
      }}
      aria-label={`编辑文字：${displayText(layer).slice(0, 20)}`}
    />
  );
}
