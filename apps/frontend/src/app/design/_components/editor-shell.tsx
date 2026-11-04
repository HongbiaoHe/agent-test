"use client";

import {
  createImageLayer,
  createTextLayer,
  DEFAULT_DESIGN_MODEL,
  DESIGN_MODEL_IDS,
  type DesignModel,
  type ImageModelChoice,
  type Layer,
  newLayerId,
} from "@agent-test/design-schema";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Maximize,
  Minus,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Sun,
  Undo2,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useDesignSession } from "../_hooks/use-design-session";
import { designApi, type DesignSnapshot } from "../_lib/api";
import { downloadBlob, exportLayerPng } from "../_lib/render";
import { useEditor } from "../_lib/store";
import { AgentDock, type AgentDockController } from "./agent-dock";
import { ExportMenu } from "./export-menu";
import { LayersPanel } from "./layers-panel";
import { type LayerActions, PropertiesPanel } from "./properties-panel";
import type { StageController, StageTool } from "./stage/design-stage";
import type { View } from "./stage/overlays";
import { ToolRail } from "./tool-rail";

// Konva 只能在浏览器里跑：画板整块按需在客户端加载
const DesignStage = dynamic(() => import("./stage/design-stage"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-workspace" />,
});

function isDesignModel(v: string | null): v is DesignModel {
  const ids: readonly string[] = DESIGN_MODEL_IDS;
  return v !== null && ids.includes(v);
}

/** 编辑器整窗：顶栏 + 左图层 + 中画板（工具条 / 缩放 / agent 输入浮层）+ 右属性。 */
export function EditorShell({ snapshot }: { snapshot: DesignSnapshot }) {
  const { store, chat } = useDesignSession(snapshot);
  const doc = useEditor(store, (s) => s.doc);
  const title = useEditor(store, (s) => s.title);
  const canUndo = useEditor(store, (s) => s.canUndo);
  const canRedo = useEditor(store, (s) => s.canRedo);
  const { resolvedTheme, setTheme } = useTheme();

  const [tool, setTool] = useState<StageTool>("select");
  const [view, setView] = useState<View | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [model, setModel] = useState<DesignModel>(
    isDesignModel(snapshot.model) ? snapshot.model : DEFAULT_DESIGN_MODEL,
  );
  const [imageChoice, setImageChoice] = useState<ImageModelChoice | null>(snapshot.imageModel);
  const stageRef = useRef<StageController | null>(null);
  const dockRef = useRef<AgentDockController | null>(null);

  const imageModels = useQuery({
    queryKey: ["design", "image-models"],
    queryFn: designApi.imageModels,
    staleTime: 10 * 60_000,
  });

  const center = () => stageRef.current?.center() ?? { x: doc.canvas.width / 2, y: doc.canvas.height / 2 };

  const addLayer = (layer: Layer) => {
    if (store.apply([{ type: "add_layers", layers: [layer] }])) store.select([layer.id]);
  };

  const addText = () => {
    const c = center();
    const width = Math.round(doc.canvas.width * 0.6);
    const fontSize = Math.round(doc.canvas.width / 14);
    const layer = createTextLayer({
      x: Math.round(c.x - width / 2),
      y: Math.round(c.y - fontSize / 2),
      width,
      height: Math.round(fontSize * 1.2),
      fontSize,
      align: "center",
      name: "标题",
    });
    addLayer(layer);
    store.setEditingText(layer.id);
  };

  const upload = async (file: File) => {
    try {
      const img = await designApi.upload(store.getState().docId, file);
      const c = center();
      const scale = Math.min(1, (doc.canvas.width * 0.6) / img.width, (doc.canvas.height * 0.6) / img.height);
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      addLayer(
        createImageLayer({
          x: Math.round(c.x - width / 2),
          y: Math.round(c.y - height / 2),
          width,
          height,
          src: img.url,
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "图片",
        }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const generateLayer = async (prompt: string, role: "element" | "background") => {
    const c = center();
    const side = Math.round(Math.min(doc.canvas.width, doc.canvas.height) * 0.45);
    const layer =
      role === "background"
        ? createImageLayer({
            x: 0,
            y: 0,
            width: doc.canvas.width,
            height: doc.canvas.height,
            role,
            name: "AI 背景",
          })
        : createImageLayer({
            x: Math.round(c.x - side / 2),
            y: Math.round(c.y - side / 2),
            width: side,
            height: side,
            role,
            name: prompt.slice(0, 16),
          });
    // 背景放最底层，元素放最上层
    if (!store.apply([{ type: "add_layers", layers: [layer], index: role === "background" ? 0 : undefined }])) return;
    store.select([layer.id]);
    try {
      // 占位图层的 add op 还在提交队列里：等它落库，后端才找得到这个图层
      await store.flush();
      await designApi.generate(store.getState().docId, layer.id, { prompt });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const actions: LayerActions = {
    regenerate: async (layerId, prompt, useCurrent) => {
      try {
        await store.flush();
        await designApi.generate(store.getState().docId, layerId, {
          prompt,
          useCurrentAsReference: useCurrent,
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    split: (layerId) => {
      if (store.getState().status === "running") {
        toast.message("Agent 正在工作，等它完成后再拆分");
        return;
      }
      dockRef.current?.sendExternal({
        text: "把这个图层拆分成可编辑的分层（普通文字变成文字图层，设计字和图形保留为透明图片图层）",
        splitLayerId: layerId,
      });
    },
    exportLayer: (layerId) => {
      const l = store.layer(layerId);
      void exportLayerPng(store.getState().doc, layerId)
        .then((blob) => downloadBlob(blob, `${(l?.name || layerId).replace(/[\\/:*?"<>|]/g, "_")}.png`))
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
    },
  };

  const retry = useCallback(
    (layerId: string) => {
      const l = store.layer(layerId);
      if (l?.type !== "image" || !l.generation) return;
      const docId = store.getState().docId;
      // 失败的是拆层：重试仍然拆层，而不是拿旧提示词重新生成
      void (l.generation.operation === "decompose"
        ? designApi.decompose(docId, layerId)
        : designApi.generate(docId, layerId, {
            prompt: l.generation.prompt,
            referenceUrls: l.generation.referenceUrls,
          })
      ).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
    },
    [store],
  );

  // 快捷键（输入控件里不拦）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = store.getState();
      const sel = s.doc.layers.filter((l) => s.selection.includes(l.id));
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        store.select(s.doc.layers.filter((l) => l.visible && !l.locked).map((l) => l.id));
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && sel.length) {
        e.preventDefault();
        const copies: Layer[] = sel.map((l) => {
          const base = { id: newLayerId(l.type === "text" ? "txt" : "img"), name: `${l.name} 副本`.slice(0, 80), x: l.x + 24, y: l.y + 24 };
          if (l.type === "text") return { ...l, ...base };
          // 副本不继承进行中的生成（结果只回写原图层，副本会一直卡在 generating）
          return l.status === "generating"
            ? { ...l, ...base, status: "ready" as const, generation: l.generation && { ...l.generation, jobId: undefined } }
            : { ...l, ...base };
        });
        if (store.apply([{ type: "add_layers", layers: copies }])) store.select(copies.map((c) => c.id));
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
        e.preventDefault();
        store.apply([{ type: "delete_layers", ids: sel.map((l) => l.id) }]);
        return;
      }
      if (e.key.startsWith("Arrow") && sel.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        store.apply([
          { type: "update_layers", updates: sel.filter((l) => !l.locked).map((l) => ({ id: l.id, patch: { x: l.x + dx, y: l.y + dy } })) },
        ]);
        return;
      }
      if (mod && (e.key === "]" || e.key === "[") && sel.length) {
        e.preventDefault();
        const ids = s.doc.layers.map((l) => l.id);
        const moving = new Set(sel.map((l) => l.id));
        const rest = ids.filter((id) => !moving.has(id));
        const order = e.key === "]" ? [...rest, ...moving] : [...moving, ...rest];
        store.apply([{ type: "reorder_layers", order }]);
        return;
      }
      if (e.key === "Escape") store.select([]);
      if (!mod && e.key === "v") setTool("select");
      if (!mod && e.key === "h") setTool("hand");
      if (!mod && e.key === "t") addText();
      if (mod && e.key === "0") {
        e.preventDefault();
        stageRef.current?.fit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commitTitle = (value: string) => {
    const next = value.trim().slice(0, 120) || "未命名设计";
    if (next === title) return;
    store.setTitle(next);
    void designApi.updateMeta(store.getState().docId, { title: next }).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          render={<Link href="/design" aria-label="返回设计列表" />}
        >
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="图层面板" aria-pressed={leftOpen} onClick={() => setLeftOpen((v) => !v)}>
          <PanelLeft />
        </Button>
        <input
          key={title}
          defaultValue={title}
          onBlur={(e) => commitTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label="设计稿名称"
          className="h-8 w-56 min-w-0 rounded-md bg-transparent px-2 text-sm font-medium outline-none hover:bg-muted focus-visible:bg-muted"
        />
        <div className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" aria-label="撤销" title="撤销 ⌘Z" disabled={!canUndo} onClick={() => store.undo()}>
          <Undo2 />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="重做" title="重做 ⇧⌘Z" disabled={!canRedo} onClick={() => store.redo()}>
          <Redo2 />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center rounded-lg border border-border">
            <Button variant="ghost" size="icon-sm" aria-label="缩小" onClick={() => stageRef.current?.zoomBy(1 / 1.25)}>
              <Minus />
            </Button>
            <button
              type="button"
              onClick={() => stageRef.current?.zoomTo(1)}
              title="点击回到 100%"
              className="w-12 text-center text-xs font-medium tabular-nums"
            >
              {view ? Math.round(view.scale * 100) : 100}%
            </button>
            <Button variant="ghost" size="icon-sm" aria-label="放大" onClick={() => stageRef.current?.zoomBy(1.25)}>
              <Plus />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="适应窗口" title="适应窗口 ⌘0" onClick={() => stageRef.current?.fit()}>
              <Maximize />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="切换明暗"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="属性面板" aria-pressed={rightOpen} onClick={() => setRightOpen((v) => !v)}>
            <PanelRight />
          </Button>
          <ExportMenu doc={doc} title={title} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className={cn("shrink-0 border-r border-border bg-card transition-[width] duration-200", leftOpen ? "w-60" : "w-0 overflow-hidden border-r-0")}>
          <div className="h-full w-60">
            <LayersPanel store={store} />
          </div>
        </aside>
        <main className="relative min-w-0 flex-1">
          <DesignStage store={store} tool={tool} controllerRef={stageRef} onViewChange={setView} onRetry={retry} />
          <div className="pointer-events-none absolute top-3 left-3 z-20">
            <ToolRail tool={tool} onTool={setTool} onAddText={addText} onUpload={upload} onGenerateLayer={generateLayer} />
          </div>
          <AgentDock
            store={store}
            chat={chat}
            model={model}
            onModelChange={(m) => {
              setModel(m);
              void designApi.updateMeta(store.getState().docId, { model: m }).catch(() => {});
            }}
            imageModels={imageModels.data ?? []}
            imageChoice={imageChoice}
            onImageChoiceChange={(c) => {
              setImageChoice(c);
              void designApi.updateMeta(store.getState().docId, { imageModel: c }).catch(() => {});
            }}
            controllerRef={dockRef}
          />
        </main>
        <aside className={cn("shrink-0 border-l border-border bg-card transition-[width] duration-200", rightOpen ? "w-72" : "w-0 overflow-hidden border-l-0")}>
          <div className="h-full w-72">
            <PropertiesPanel store={store} actions={actions} />
          </div>
        </aside>
      </div>
    </div>
  );
}
