"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import type {
  DockSide,
  PanelRect,
  Placement,
  ResizeDir,
} from "./types";
import { useStoredState } from "./use-stored-state";

/** 停靠态与画布边缘的留白：面板是「悬浮在画布上」而不是嵌进去，四周要露出底图。 */
export const PANEL_INSET = 12;
/**
 * 「要吸附」的判定距离：**面板自身的左/右边**离画布对应边缘多近。
 *
 * 刻意不看指针位置——面板被 clamp 在画布内，而指针相对面板的抓取点在整个拖动过程中固定，
 * 所以面板顶到左缘时指针离左缘仍有大半个面板宽（抓标题栏中央就是 ~width/2），
 * 按指针判定的话左侧吸附永远够不到。看面板的边才符合「把窗口推到边上」的直觉。
 */
const SNAP_ZONE = 48;
/** 按下后位移超过它才算拖动，避免点标题栏被判成拖拽（ux: drag-threshold）。 */
const DRAG_THRESHOLD = 4;
/** 从停靠态拖出来时收成的高度占比——不收的话浮动态和停靠态长得一样，看不出已脱离。 */
const UNDOCK_HEIGHT_RATIO = 0.62;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** localStorage 里的面板位置：我方自有数据，但仍走守卫而非断言（键名/结构可能是旧版本写的）。 */
function parsePlacement(raw: unknown): Placement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const width = num(o.width);
  if (width === null) return null;
  if (o.mode === "dock") {
    return o.side === "left" || o.side === "right"
      ? { mode: "dock", side: o.side, width }
      : null;
  }
  if (o.mode === "float") {
    const x = num(o.x);
    const y = num(o.y);
    const height = num(o.height);
    return x === null || y === null || height === null
      ? null
      : { mode: "float", x, y, width, height };
  }
  return null;
}

export interface FloatingPanelOptions {
  /** localStorage 键（位置与尺寸）。 */
  storageKey: string;
  /** 未持久化过时的初始位置。必须是稳定引用（模块常量）。 */
  defaultPlacement: Placement;
  /** 允许拖出来自由浮动；false = 只能贴边停靠、只能改宽度。 */
  allowFloat?: boolean;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  /**
   * 停靠态额外向内让出的宽度（px）。同一侧已经停着别的面板时传它的宽度 + 间距：
   * 贴边位留给先占住的那块，本面板排在它旁边，两块同侧共存而不是互相顶掉。
   * 默认 0（贴边）。
   */
  dockOffset?: number;
  /**
   * 顶部让出的高度（px）。画布顶部压着悬浮 header 时传「header 底边 + 间距」，
   * 面板的停靠、浮动、拖动与向上缩放都不会再钻到它底下。默认贴 PANEL_INSET。
   */
  topInset?: number;
  /**
   * 画布容器元素：定位基准 + 边界/吸附判定。
   * 收元素本身而不是 RefObject——ref 的引用恒定，effect 依赖它就永远不会因为容器
   * 换了个 DOM 节点而重跑（桌面/手机分支互斥渲染时会换），ResizeObserver 会一直
   * 盯着旧的、已脱离文档的节点，量出 0×0，面板整个飞到画布外。
   */
  bounds: HTMLElement | null;
}

export interface FloatingPanelApi {
  placement: Placement;
  /** 面板根元素样式：永远是 left/top/width/height 四个键——见下方「为什么不用 right/bottom」。 */
  style: CSSProperties;
  /** 挂到面板根元素的 ref 回调。用回调而非 RefObject：ref 不外泄，调用方不会踩到
   *  react-hooks/refs 的「渲染期访问 ref」。 */
  setPanelEl: (el: HTMLDivElement | null) => void;
  /** 挂到标题栏；allowFloat=false 时为空对象（标题栏不可拖）。 */
  dragHandleProps: { onPointerDown?: (e: ReactPointerEvent) => void };
  /** 当前该渲染哪些缩放把手：停靠态只有贴向画布内侧的那一条边。 */
  resizeDirs: ResizeDir[];
  getResizeHandleProps: (dir: ResizeDir) => {
    onPointerDown: (e: ReactPointerEvent) => void;
  };
  /** 正在拖动或缩放：外层据此关掉过渡动画、压暗内容。 */
  interacting: boolean;
  /** 拖到边缘将要吸附的一侧（null=不吸附）。 */
  snapHint: DockSide | null;
  /** 吸附落点的预览矩形样式；无吸附时为 null。 */
  snapPreviewStyle: CSSProperties | null;
}

interface Gesture {
  kind: "move" | ResizeDir;
  startX: number;
  startY: number;
  rect: PanelRect;
  boundsW: number;
  boundsH: number;
  moved: boolean;
}

/**
 * 可拖动 / 可缩放 / 可靠边吸附的面板定位状态机。
 *
 * **为什么定位样式恒为 left/top/width/height 四键**：拖动期间为了不让面板里的内容
 * （对话流那种大树）每帧重渲染，位置是直接写 DOM 内联样式的，React 并不知情。React 的
 * style diff 比的是它自己上一次的 style 对象而非真实 DOM，所以键集合一旦变化（比如停靠态
 * 用 right/bottom、浮动态用 left/top），落位后被我们手写进去的键就再也清不掉。恒定四键 +
 * 落位值等于实时值，就没有这个问题。
 *
 * 停靠态的像素矩形由容器尺寸算出（ResizeObserver 跟踪），因此窗口变小、面板跑到视野外的
 * 情况会在渲染期自动夹紧，不需要额外写回存储。
 */
export function useFloatingPanel({
  storageKey,
  defaultPlacement,
  allowFloat = true,
  minWidth,
  maxWidth,
  minHeight,
  dockOffset = 0,
  topInset = PANEL_INSET,
  bounds: boundsEl,
}: FloatingPanelOptions): FloatingPanelApi {
  const [placement, setPlacement] = useStoredState(
    storageKey,
    defaultPlacement,
    parsePlacement,
  );
  const [bounds, setBounds] = useState<{ w: number; h: number } | null>(null);
  const [interacting, setInteracting] = useState(false);
  // 吸附提示连宽度一起存：预览矩形要在渲染期用它，不能回头去读手势 ref
  const [snap, setSnap] = useState<{ side: DockSide; width: number } | null>(
    null,
  );

  const panelElRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const liveRef = useRef<PanelRect | null>(null);
  // 吸附侧要在指针回调里同步比对（setSnapHint 是异步的），用 ref 存一份即时值
  const snapRef = useRef<DockSide | null>(null);

  // 容器尺寸：停靠态的像素矩形与吸附预览都要它。
  // setBounds 走微任务 / ResizeObserver 回调，都不在 effect 同步体里，
  // 因此不触发 react-hooks/set-state-in-effect（Next16 里是 error 级）。
  useEffect(() => {
    if (!boundsEl) return;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const r = boundsEl.getBoundingClientRect();
      setBounds((prev) =>
        prev && prev.w === r.width && prev.h === r.height
          ? prev
          : { w: r.width, h: r.height },
      );
    };
    // 挂载时自己先量一次：ResizeObserver 的首次通知挂在渲染步骤上，页面在后台标签
    // 或预览面板收起时渲染帧被暂停，那条通知不会来，面板就会一直停在隐藏的兜底位置。
    queueMicrotask(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(boundsEl);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [boundsEl]);

  /** 当前该渲染的像素矩形；容器还没量出来时为 null（面板此时藏着，不会闪一帧错位）。 */
  const rect = useMemo<PanelRect | null>(() => {
    if (!bounds) return null;
    const maxW = Math.max(minWidth, bounds.w - PANEL_INSET * 2);
    if (placement.mode === "dock") {
      // 同侧已有面板时把可用宽度和起点都往里推 dockOffset
      const room = Math.max(minWidth, bounds.w - PANEL_INSET * 2 - dockOffset);
      const width = clamp(placement.width, minWidth, Math.min(maxWidth, room));
      const x =
        placement.side === "left"
          ? PANEL_INSET + dockOffset
          : bounds.w - PANEL_INSET - dockOffset - width;
      return {
        // 两块面板加起来放不下时宁可挨着重叠一点，也不让面板被推出画布
        x: clamp(x, PANEL_INSET, Math.max(PANEL_INSET, bounds.w - PANEL_INSET - width)),
        y: topInset,
        width,
        height: Math.max(minHeight, bounds.h - topInset - PANEL_INSET),
      };
    }
    const width = clamp(placement.width, minWidth, Math.min(maxWidth, maxW));
    const height = clamp(placement.height, minHeight, Math.max(minHeight, bounds.h));
    return {
      x: clamp(placement.x, 0, Math.max(0, bounds.w - width)),
      y: clamp(placement.y, topInset, Math.max(topInset, bounds.h - height)),
      width,
      height,
    };
  }, [bounds, placement, minWidth, maxWidth, minHeight, dockOffset, topInset]);

  // React 只负责「量出来之前先藏着」；定位四键一概不交给它，理由见下方 layout effect
  const style = useMemo<CSSProperties>(
    () => (rect ? {} : { visibility: "hidden" }),
    [rect],
  );

  const setPanelEl = useCallback((el: HTMLDivElement | null) => {
    panelElRef.current = el;
  }, []);

  const applyRect = useCallback((r: PanelRect) => {
    const el = panelElRef.current;
    if (!el) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }, []);

  const applyLive = useCallback(() => {
    if (liveRef.current) applyRect(liveRef.current);
  }, [applyRect]);

  /**
   * left/top/width/height 全部由这里写，不放进 React 的 style 对象。
   *
   * 拖动/缩放期间这四个值是逐帧直接写 DOM 的，React 完全不知情；而它的 style diff 比的是
   * 自己上一次渲染的对象，不是真实 DOM。于是落位后只要某个键的新值恰好等于它上次渲染的值
   * （典型：从停靠态拖出 → 高度收成浮动高度 → 又吸附回同一侧，height 变回 776 而 React
   * 记的也是 776），它就不会重写，DOM 里会一直留着拖动期间的中间值。四个键全部自己管就
   * 没有这个失配；顺带也挡住了手势进行中的无关重渲染（socket 推消息等）把样式覆盖回去。
   */
  useLayoutEffect(() => {
    if (gestureRef.current) applyLive();
    else if (rect) applyRect(rect);
  });

  const begin = useCallback(
    (e: ReactPointerEvent, kind: "move" | ResizeDir) => {
      if (e.button !== 0) return;
      const el = panelElRef.current;
      if (!boundsEl || !el) return;
      e.preventDefault();
      const b = boundsEl.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const start: PanelRect = {
        x: r.left - b.left,
        y: r.top - b.top,
        width: r.width,
        height: r.height,
      };
      gestureRef.current = {
        kind,
        startX: e.clientX,
        startY: e.clientY,
        rect: start,
        boundsW: b.width,
        boundsH: b.height,
        moved: false,
      };
      liveRef.current = { ...start };
      setInteracting(true);
    },
    [boundsEl],
  );

  // 手势期间在 window 上听：指针拖到面板外（乃至画布外）也要继续跟随
  useEffect(() => {
    if (!interacting) return;

    const onMove = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!g.moved) {
        g.moved = true;
        // 从停靠态拖出来：这时才收成浮动高度。标题栏在顶部，收高度不会把面板从指针下抽走。
        // 必须等「真的开始移动」——放在 pointerdown 里的话，纯点击（点 pin / token 徽标 /
        // 标题栏空白）也会改高度，而 onEnd 判定没移动就直接返回、不落位，
        // React 又认为 placement 没变而不重写样式，于是留下「高度已缩小但仍是 dock」的
        // 坏状态：停靠态不渲染上下把手，用户再也调不回高度。
        if (g.kind === "move" && allowFloat && placement.mode === "dock") {
          g.rect.height = clamp(
            Math.round(g.boundsH * UNDOCK_HEIGHT_RATIO),
            minHeight,
            Math.max(minHeight, g.boundsH - PANEL_INSET * 2),
          );
        }
      }

      const r: PanelRect = { ...g.rect };
      if (g.kind === "move") {
        r.x = clamp(g.rect.x + dx, 0, Math.max(0, g.boundsW - g.rect.width));
        r.y = clamp(
          g.rect.y + dy,
          topInset,
          Math.max(topInset, g.boundsH - g.rect.height),
        );
        // r 已被 clamp 在画布内，所以这两个距离恒 >= 0：面板顶到边缘时正好是 0
        const gapLeft = r.x;
        const gapRight = g.boundsW - (r.x + r.width);
        const hint: DockSide | null =
          gapLeft < SNAP_ZONE
            ? "left"
            : gapRight < SNAP_ZONE
              ? "right"
              : null;
        if (snapRef.current !== hint) {
          snapRef.current = hint;
          setSnap(hint ? { side: hint, width: r.width } : null);
        }
      } else {
        const maxW = Math.min(maxWidth, Math.max(minWidth, g.boundsW - PANEL_INSET * 2));
        if (g.kind.includes("e")) {
          r.width = clamp(g.rect.width + dx, minWidth, maxW);
        }
        if (g.kind.includes("w")) {
          r.width = clamp(g.rect.width - dx, minWidth, maxW);
          r.x = g.rect.x + (g.rect.width - r.width);
        }
        if (g.kind.includes("s")) {
          r.height = clamp(g.rect.height + dy, minHeight, g.boundsH - g.rect.y);
        }
        if (g.kind.includes("n")) {
          // 上界是「下边缘到 topInset 的距离」：再往上就钻到 header 底下了
          r.height = clamp(
            g.rect.height - dy,
            minHeight,
            Math.max(minHeight, g.rect.y + g.rect.height - topInset),
          );
          r.y = g.rect.y + (g.rect.height - r.height);
        }
      }
      liveRef.current = r;
      applyLive();
    };

    const onEnd = () => {
      const g = gestureRef.current;
      const r = liveRef.current;
      const hint = snapRef.current;
      gestureRef.current = null;
      snapRef.current = null;
      setSnap(null);
      setInteracting(false);
      // 没越过阈值 = 纯点击，别落位（也别把 width 抹成小数）
      if (!g || !g.moved || !r) return;

      const width = Math.round(r.width);
      let next: Placement;
      if (g.kind !== "move" && placement.mode === "dock") {
        next = { ...placement, width };
      } else if (g.kind === "move" && hint) {
        next = { mode: "dock", side: hint, width };
      } else if (allowFloat) {
        next = {
          mode: "float",
          x: Math.round(r.x),
          y: Math.round(r.y),
          width,
          height: Math.round(r.height),
        };
      } else {
        const side: DockSide = placement.mode === "dock" ? placement.side : "left";
        next = { mode: "dock", side, width };
      }
      setPlacement(next);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [
    interacting,
    allowFloat,
    applyLive,
    maxWidth,
    minWidth,
    minHeight,
    placement,
    setPlacement,
    topInset,
  ]);

  const dragHandleProps = useMemo(
    () =>
      allowFloat
        ? {
            onPointerDown: (e: ReactPointerEvent) => {
              // 标题栏右侧塞着 pin / 关闭 / 业务按钮，pointerdown 会冒泡到这里。
              // 落在控件上就不当拖动：既避免手抖 4px 把面板拖离停靠位，
              // 也避免 begin 的 preventDefault 吃掉这些控件的点击。
              if (
                e.target instanceof Element &&
                e.target.closest("button, a, input, textarea, select, [role='button']")
              ) {
                return;
              }
              begin(e, "move");
            },
          }
        : {},
    [allowFloat, begin],
  );

  const getResizeHandleProps = useCallback(
    (dir: ResizeDir) => ({
      onPointerDown: (e: ReactPointerEvent) => begin(e, dir),
    }),
    [begin],
  );

  const resizeDirs = useMemo<ResizeDir[]>(
    () =>
      placement.mode === "dock"
        ? [placement.side === "left" ? "e" : "w"]
        : ["n", "s", "e", "w", "ne", "nw", "se", "sw"],
    [placement],
  );

  const snapPreviewStyle = useMemo<CSSProperties | null>(() => {
    if (!snap || !bounds) return null;
    const width = clamp(
      snap.width,
      minWidth,
      Math.max(minWidth, bounds.w - PANEL_INSET * 2),
    );
    return {
      left: snap.side === "left" ? PANEL_INSET : bounds.w - PANEL_INSET - width,
      top: topInset,
      width,
      height: Math.max(minHeight, bounds.h - topInset - PANEL_INSET),
    };
  }, [snap, bounds, minWidth, minHeight, topInset]);

  return {
    placement,
    style,
    setPanelEl,
    dragHandleProps,
    resizeDirs,
    getResizeHandleProps,
    interacting,
    snapHint: snap?.side ?? null,
    snapPreviewStyle,
  };
}
