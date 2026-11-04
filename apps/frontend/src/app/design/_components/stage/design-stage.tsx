"use client";

import type { DesignOp, Layer, LayerPatch } from "@agent-test/design-schema";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer as KLayer, Line, Rect, Stage, Transformer } from "react-konva";

import { cn } from "@/lib/utils";

import { loadDocumentFonts } from "../../_lib/fonts";
import { type DesignStore, useEditor } from "../../_lib/store";
import { useStageColors } from "../../_lib/theme-colors";
import { LayerNode } from "./layer-node";
import {
  AgentCursor,
  AgentOrbits,
  AgentOverlays,
  orbitItems,
  ArtboardLabel,
  ArtboardUnderlay,
  GenerationOverlays,
  TextEditOverlay,
  type View,
} from "./overlays";
import { type Guide, snapBox } from "./snapping";

export type StageTool = "select" | "hand";

/** 外层（缩放控件、快捷键）拿到的画板控制器。 */
export interface StageController {
  fit: () => void;
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
  /** 视口中心对应的设计稿坐标（新图层放这儿） */
  center: () => { x: number; y: number };
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const FIT_PADDING = 96;

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export default function DesignStage({
  store,
  tool,
  controllerRef,
  onViewChange,
  onRetry,
}: {
  store: DesignStore;
  tool: StageTool;
  controllerRef: RefObject<StageController | null>;
  onViewChange: (view: View) => void;
  onRetry: (layerId: string) => void;
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const editingTextId = useEditor(store, (s) => s.editingTextId);
  const status = useEditor(store, (s) => s.status);
  const focus = useEditor(store, (s) => s.focus);
  const agentAdded = useEditor(store, (s) => s.agentAdded);
  const agentWork = useEditor(store, (s) => s.agentWork);
  const colors = useStageColors();
  const running = status === "running";
  const orbits = orbitItems(doc, agentWork, running);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setViewState] = useState<View>({ x: 0, y: 0, scale: 0.5 });
  const [fitted, setFitted] = useState(false);
  const fittedRef = useRef(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [fontsVersion, setFontsVersion] = useState(0);

  const setView = useCallback(
    (v: View) => {
      setViewState(v);
      onViewChange(v);
    },
    [onViewChange],
  );

  const fitView = useCallback(
    (w = size.width, h = size.height) => {
      if (!w || !h) return;
      const scale = Math.min(
        (w - FIT_PADDING * 2) / doc.canvas.width,
        (h - FIT_PADDING * 2) / doc.canvas.height,
        1,
      );
      const s = Math.max(MIN_SCALE, scale);
      setView({
        scale: s,
        x: (w - doc.canvas.width * s) / 2,
        // 底部留给 agent 输入框
        y: (h - doc.canvas.height * s) / 2 - 24,
      });
    },
    [doc.canvas.width, doc.canvas.height, size.width, size.height, setView],
  );

  // 容器尺寸：首次拿到尺寸时自动适配视图
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      if (!fittedRef.current && width && height) {
        fittedRef.current = true;
        fitView(width, height);
        setFitted(true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView]);

  const zoomAround = useCallback(
    (next: number, px: number, py: number) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      const dx = (px - view.x) / view.scale;
      const dy = (py - view.y) / view.scale;
      setView({ scale: s, x: px - dx * s, y: py - dy * s });
    },
    [view, setView],
  );

  useEffect(() => {
    controllerRef.current = {
      fit: () => fitView(),
      zoomBy: (f) => zoomAround(view.scale * f, size.width / 2, size.height / 2),
      zoomTo: (s) => zoomAround(s, size.width / 2, size.height / 2),
      center: () => ({
        x: (size.width / 2 - view.x) / view.scale,
        y: (size.height / 2 - view.y) / view.scale,
      }),
    };
  }, [controllerRef, fitView, zoomAround, view, size]);

  // 字体就绪后重画文字（并触发量高）
  useEffect(() => {
    let alive = true;
    void loadDocumentFonts(doc).then(() => {
      if (alive) setFontsVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [doc]);

  // 空格按住 = 临时抓手
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // 选中集合挂到 Transformer 上
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = selection
      .filter((id) => id !== editingTextId)
      .map((id) => stage.findOne(`#${id}`))
      .filter((n): n is Konva.Node => Boolean(n));
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selection, editingTextId, doc, fontsVersion]);

  const panning = tool === "hand" || spaceDown;

  // ——— 画板交互 ———

  const toDesign = (px: number, py: number) => ({
    x: (px - view.x) / view.scale,
    y: (py - view.y) / view.scale,
  });

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // 触控板捏合与 ⌘/Ctrl + 滚轮：以指针为中心缩放
      zoomAround(view.scale * Math.exp(-e.evt.deltaY * 0.01), pointer.x, pointer.y);
    } else {
      setView({ ...view, x: view.x - e.evt.deltaX, y: view.y - e.evt.deltaY });
    }
  };

  const onStageMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (panning) return;
    // 点在图层上由图层自己处理（cancelBubble）；点在 Transformer 手柄上不动选择
    if (e.target.getParent()?.className === "Transformer") return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const p = toDesign(pointer.x, pointer.y);
    if (!e.evt.shiftKey) store.select([]);
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onStageMouseMove = () => {
    if (!marquee) return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const p = toDesign(pointer.x, pointer.y);
    setMarquee({ ...marquee, x1: p.x, y1: p.y });
  };

  const onStageMouseUp = (e: KonvaEventObject<MouseEvent>) => {
    if (!marquee) return;
    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    setMarquee(null);
    if (w < 3 / view.scale && h < 3 / view.scale) return;
    const hit = doc.layers
      .filter(
        (l) =>
          l.visible &&
          !l.locked &&
          l.x < x + w &&
          l.x + l.width > x &&
          l.y < y + h &&
          l.y + l.height > y,
      )
      .map((l) => l.id);
    store.select(e.evt.shiftKey ? [...new Set([...selection, ...hit])] : hit);
  };

  const onSelect = useCallback(
    (id: string, additive: boolean) => {
      const cur = store.getState().selection;
      if (additive) {
        store.select(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
      } else if (!cur.includes(id)) {
        store.select([id]);
      }
    },
    [store],
  );

  const layerById = useMemo(() => new Map(doc.layers.map((l) => [l.id, l])), [doc.layers]);

  /** Konva 节点（中心定位）→ 图层左上角坐标。 */
  const nodeBox = (node: Konva.Node, layer: Layer) => {
    const w = layer.width * Math.abs(node.scaleX());
    const h = (layer.type === "text" ? node.height() : layer.height) * Math.abs(node.scaleY());
    return { x: node.x() - w / 2, y: node.y() - h / 2, width: w, height: h };
  };

  const onDragMove = (e: KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const layer = layerById.get(node.id());
    if (!layer || store.getState().selection.length > 1) {
      setGuides([]);
      return;
    }
    const box = nodeBox(node, layer);
    const { dx, dy, guides: g } = snapBox(doc, box, [layer.id], 6 / view.scale);
    if (dx || dy) node.position({ x: node.x() + dx, y: node.y() + dy });
    setGuides(g);
  };

  const onDragEnd = () => {
    setGuides([]);
    const stage = stageRef.current;
    if (!stage) return;
    const ids = store.getState().selection;
    const updates = ids.flatMap((id) => {
      const node = stage.findOne(`#${id}`);
      const layer = layerById.get(id);
      if (!node || !layer) return [];
      const box = nodeBox(node, layer);
      if (Math.abs(box.x - layer.x) < 0.01 && Math.abs(box.y - layer.y) < 0.01) return [];
      return [{ id, patch: { x: round(box.x), y: round(box.y) } }];
    });
    if (updates.length) store.apply([{ type: "update_layers", updates }]);
  };

  const onTransform = () => {
    // 文字左右拉伸 = 改换行宽度而不是把字压扁：实时把 scaleX 折算进 width
    const tr = trRef.current;
    const anchor = tr?.getActiveAnchor() ?? "";
    if (!tr || !/middle-(left|right)/.test(anchor)) return;
    for (const node of tr.nodes()) {
      if (!(node instanceof Konva.Text)) continue;
      const width = Math.max(20, node.width() * node.scaleX());
      node.setAttrs({ width, scaleX: 1, offsetX: width / 2 });
    }
  };

  const onTransformEnd = () => {
    const tr = trRef.current;
    if (!tr) return;
    const updates: { id: string; patch: LayerPatch }[] = [];
    for (const node of tr.nodes()) {
      const layer = layerById.get(node.id());
      if (!layer) continue;
      const sx = Math.abs(node.scaleX());
      const sy = Math.abs(node.scaleY());
      if (layer.type === "text" && node instanceof Konva.Text) {
        const text = node;
        const width = text.width() * sx;
        const fontSize = layer.fontSize * sy;
        updates.push({
          id: layer.id,
          patch: {
            x: round(node.x() - width / 2),
            y: round(node.y() - (text.height() * sy) / 2),
            width: round(width),
            fontSize: round(Math.max(4, fontSize)),
            rotation: round(node.rotation()),
          },
        });
      } else {
        const width = layer.width * sx;
        const height = layer.height * sy;
        updates.push({
          id: layer.id,
          patch: {
            x: round(node.x() - width / 2),
            y: round(node.y() - height / 2),
            width: round(width),
            height: round(height),
            rotation: round(node.rotation()),
          },
        });
      }
      // 缩放已折算进尺寸：节点复位（保留翻转的符号）
      node.scaleX(Math.sign(node.scaleX()) || 1);
      node.scaleY(Math.sign(node.scaleY()) || 1);
    }
    if (updates.length) store.apply([{ type: "update_layers", updates }]);
  };

  const onMeasured = useCallback(
    (id: string, height: number) => {
      const ops: DesignOp[] = [
        { type: "update_layers", updates: [{ id, patch: { height: round(height) } }] },
      ];
      store.apply(ops, { record: false });
    },
    [store],
  );

  const editingLayer = editingTextId ? layerById.get(editingTextId) : undefined;
  const singleText =
    selection.length === 1 && layerById.get(selection[0])?.type === "text";

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full overflow-hidden bg-workspace",
        panning ? "cursor-grab active:cursor-grabbing" : "cursor-default",
      )}
    >
      {size.width > 0 && colors && fitted && (
        <>
          <ArtboardUnderlay doc={doc} view={view} />
          <ArtboardLabel doc={doc} view={view} running={running} />
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            x={view.x}
            y={view.y}
            scaleX={view.scale}
            scaleY={view.scale}
            draggable={panning}
            onDragEnd={(e) => {
              if (e.target === stageRef.current) {
                setView({ ...view, x: e.target.x(), y: e.target.y() });
              }
            }}
            onWheel={onWheel}
            onMouseDown={onStageMouseDown}
            onMouseMove={onStageMouseMove}
            onMouseUp={onStageMouseUp}
            className="absolute inset-0"
          >
            <KLayer>
              {/* 画板裁切：画板外的部分不显示，与导出一致 */}
              <Group clipX={0} clipY={0} clipWidth={doc.canvas.width} clipHeight={doc.canvas.height}>
                {doc.layers.map((l) =>
                  l.visible ? (
                    <LayerNode
                      key={l.id}
                      layer={l}
                      hidden={l.id === editingTextId}
                      fontsVersion={fontsVersion}
                      placeholderColor={colors.checkerB}
                      draggable={!panning}
                      onSelect={onSelect}
                      onDragStart={(id) => {
                        if (!store.getState().selection.includes(id)) store.select([id]);
                      }}
                      onDragMove={onDragMove}
                      onDragEnd={onDragEnd}
                      onEditText={(id) => {
                        store.select([id]);
                        store.setEditingText(id);
                      }}
                      onMeasured={onMeasured}
                    />
                  ) : null,
                )}
              </Group>
            </KLayer>
            <KLayer>
              {guides.map((g, i) => (
                <Line
                  key={i}
                  points={
                    g.orientation === "v"
                      ? [g.pos, -10000, g.pos, 10000]
                      : [-10000, g.pos, 10000, g.pos]
                  }
                  stroke={colors.agent}
                  strokeWidth={1 / view.scale}
                  dash={[4 / view.scale, 4 / view.scale]}
                  listening={false}
                />
              ))}
              {marquee && (
                <Rect
                  x={Math.min(marquee.x0, marquee.x1)}
                  y={Math.min(marquee.y0, marquee.y1)}
                  width={Math.abs(marquee.x1 - marquee.x0)}
                  height={Math.abs(marquee.y1 - marquee.y0)}
                  stroke={colors.selection}
                  strokeWidth={1 / view.scale}
                  fill={colors.selection.replace(/[\d.]+\)$/, "0.08)")}
                  listening={false}
                />
              )}
              <Transformer
                ref={trRef}
                rotateEnabled
                flipEnabled={false}
                borderStroke={colors.selection}
                borderStrokeWidth={1.5}
                anchorStroke={colors.selection}
                anchorFill={colors.surface}
                anchorSize={9}
                anchorCornerRadius={2}
                rotateAnchorOffset={24}
                padding={2}
                ignoreStroke
                enabledAnchors={
                  singleText
                    ? ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]
                    : undefined
                }
                boundBoxFunc={(oldBox, newBox) =>
                  Math.abs(newBox.width) < 8 || Math.abs(newBox.height) < 8 ? oldBox : newBox
                }
                onTransform={onTransform}
                onTransformEnd={onTransformEnd}
              />
            </KLayer>
          </Stage>
          <div className="pointer-events-none absolute inset-0">
            <GenerationOverlays
              doc={doc}
              view={view}
              onRetry={onRetry}
              orbiting={new Set(orbits.map((o) => o.layer.id))}
            />
            <AgentOverlays doc={doc} view={view} added={agentAdded} />
            <AgentOrbits view={view} items={orbits} />
            <AgentCursor doc={doc} view={view} focus={focus} running={running} busy={orbits.length > 0} />
          </div>
          {editingLayer?.type === "text" && (
            <TextEditOverlay
              key={editingLayer.id}
              layer={editingLayer}
              view={view}
              onCommit={(text) => {
                store.setEditingText(null);
                if (text !== null) {
                  store.apply([
                    { type: "update_layers", updates: [{ id: editingLayer.id, patch: { text } }] },
                  ]);
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
