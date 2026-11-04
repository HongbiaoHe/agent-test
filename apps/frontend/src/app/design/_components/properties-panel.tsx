"use client";

import {
  CANVAS_PRESETS,
  type DesignDocument,
  FONT_CATALOG,
  fontInfo,
  type ImageLayer,
  type Layer,
  type LayerPatch,
  type TextLayer,
} from "@agent-test/design-schema";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  CaseUpper,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Loader2,
  Scissors,
  Strikethrough,
  Underline,
  Wand2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { loadFont } from "../_lib/fonts";
import { type DesignStore, useEditor } from "../_lib/store";
import { ColorField, NumberField, Row, Section } from "./fields";

export interface LayerActions {
  regenerate: (layerId: string, prompt: string, useCurrent: boolean) => Promise<void>;
  split: (layerId: string) => void;
  exportLayer: (layerId: string) => void;
}

/** 右侧属性面板：未选中 → 画布；单选 → 该图层；多选 → 对齐与共有属性。 */
export function PropertiesPanel({
  store,
  actions,
}: {
  store: DesignStore;
  actions: LayerActions;
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const layers = doc.layers.filter((l) => selection.includes(l.id));
  const patch = (id: string, p: LayerPatch) =>
    store.apply([{ type: "update_layers", updates: [{ id, patch: p }] }]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-4 text-sm font-semibold">
        {layers.length === 0
          ? "画布"
          : layers.length === 1
            ? layers[0].name || "图层"
            : `已选 ${layers.length} 个图层`}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {layers.length === 0 && <CanvasProps store={store} doc={doc} />}
        {layers.length > 1 && <MultiProps store={store} doc={doc} layers={layers} />}
        {layers.length === 1 && (
          <>
            <GeometryProps layer={layers[0]} onPatch={(p) => patch(layers[0].id, p)} />
            {layers[0].type === "text" ? (
              <TextProps layer={layers[0]} onPatch={(p) => patch(layers[0].id, p)} />
            ) : (
              <ImageProps
                key={layers[0].id}
                layer={layers[0]}
                onPatch={(p) => patch(layers[0].id, p)}
                actions={actions}
              />
            )}
            <Section title="导出">
              <Button variant="outline" size="sm" className="w-full" onClick={() => actions.exportLayer(layers[0].id)}>
                <Download />
                导出此图层 PNG
              </Button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function CanvasProps({ store, doc }: { store: DesignStore; doc: DesignDocument }) {
  const { width, height, background } = doc.canvas;
  const setCanvas = (p: Partial<DesignDocument["canvas"]>) =>
    store.apply([{ type: "set_canvas", patch: p }]);
  const preset = CANVAS_PRESETS.find((p) => p.width === width && p.height === height)?.key ?? "custom";
  const presetItems: Record<string, string> = Object.fromEntries([
    ...CANVAS_PRESETS.map((p) => [p.key, `${p.label} · ${p.width}×${p.height}`]),
    ["custom", "自定义尺寸"],
  ]);
  return (
    <>
      <Section title="尺寸">
        <Select
          items={presetItems}
          value={preset}
          onValueChange={(v) => {
            const p = CANVAS_PRESETS.find((x) => x.key === v);
            if (p) setCanvas({ width: p.width, height: p.height });
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(presetItems).map(([k, label]) => (
              <SelectItem key={k} value={k} disabled={k === "custom"}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Row>
          <NumberField label="W" value={width} min={64} max={8192} onCommit={(v) => setCanvas({ width: Math.round(v) })} />
          <NumberField label="H" value={height} min={64} max={8192} onCommit={(v) => setCanvas({ height: Math.round(v) })} />
        </Row>
      </Section>
      <Section
        title="底色"
        action={
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            透明
            <Switch
              size="sm"
              checked={background === "transparent"}
              onCheckedChange={(on) => setCanvas({ background: on ? "transparent" : "#F4F1EC" })}
            />
          </label>
        }
      >
        {background !== "transparent" ? (
          <ColorField value={background} onCommit={(hex) => setCanvas({ background: hex })} label="画布底色" />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            透明底导出 PNG 时保留 alpha，可直接拿去叠加。
          </p>
        )}
      </Section>
      <Section title="提示">
        <p className="text-xs leading-relaxed text-muted-foreground">
          双击文字直接改字；按住空格拖动画布；⌘ + 滚轮缩放。也可以在下方让 Agent 帮你排版、生成或复刻一张参考图。
        </p>
      </Section>
    </>
  );
}

function GeometryProps({ layer, onPatch }: { layer: Layer; onPatch: (p: LayerPatch) => void }) {
  return (
    <Section title="位置与尺寸">
      <Row>
        <NumberField label="X" value={layer.x} onCommit={(x) => onPatch({ x })} />
        <NumberField label="Y" value={layer.y} onCommit={(y) => onPatch({ y })} />
      </Row>
      <Row>
        <NumberField label="W" value={layer.width} min={1} onCommit={(width) => onPatch(resize(layer, { width }))} />
        <NumberField
          label="H"
          value={layer.height}
          min={1}
          onCommit={(height) => onPatch(layer.type === "text" ? {} : resize(layer, { height }))}
        />
      </Row>
      <Row>
        <NumberField label="R" value={layer.rotation} min={-360} max={360} suffix="°" onCommit={(rotation) => onPatch({ rotation })} />
        <NumberField
          label="%"
          value={layer.opacity * 100}
          min={0}
          max={100}
          onCommit={(v) => onPatch({ opacity: Math.round(v) / 100 })}
        />
      </Row>
    </Section>
  );
}

/** 图片按住比例改尺寸（中心不动）；文字只改宽度。 */
function resize(layer: Layer, next: { width?: number; height?: number }): LayerPatch {
  if (layer.type === "text") return { width: next.width ?? layer.width };
  const ratio = layer.width / layer.height;
  const width = next.width ?? (next.height ?? layer.height) * ratio;
  const height = next.height ?? width / ratio;
  return {
    width,
    height,
    x: layer.x + (layer.width - width) / 2,
    y: layer.y + (layer.height - height) / 2,
  };
}

const FONT_ITEMS: Record<string, string> = Object.fromEntries(FONT_CATALOG.map((f) => [f.family, f.label]));

function TextProps({ layer, onPatch }: { layer: TextLayer; onPatch: (p: LayerPatch) => void }) {
  const weights: readonly number[] = fontInfo(layer.fontFamily)?.weights ?? [400];
  const decoration = [
    ...(layer.fontStyle === "italic" ? ["italic"] : []),
    ...(layer.textDecoration !== "none" ? [layer.textDecoration] : []),
    ...(layer.textTransform === "uppercase" ? ["uppercase"] : []),
  ];
  return (
    <>
      <Section title="文字">
        <Textarea
          // 文案在画布上原地改、或被 agent 改了之后，这里要跟着换成新值
          key={`${layer.id}:${layer.text}`}
          defaultValue={layer.text}
          rows={3}
          onBlur={(e) => {
            if (e.target.value !== layer.text) onPatch({ text: e.target.value });
          }}
          className="min-h-16 resize-y text-sm"
          aria-label="文案"
        />
        <Select
          items={FONT_ITEMS}
          value={layer.fontFamily}
          onOpenChange={(open) => {
            // 下拉里每一项用自己的字体预览：打开时把白名单字体都请求上（只拉标签用到的字）
            if (open) FONT_CATALOG.forEach((f) => void loadFont(f.family, 400, f.label));
          }}
          onValueChange={(v) => {
            const f = FONT_CATALOG.find((x) => x.family === v);
            if (f) onPatch({ fontFamily: f.family });
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {FONT_CATALOG.map((f) => (
              <SelectItem key={f.family} value={f.family}>
                <span className="flex flex-col">
                  {/* 预览用字体本身渲染（字体名是文档数据） */}
                  <span style={{ fontFamily: `"${f.family}"` }} className="text-sm">
                    {f.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{f.mood}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Row>
          <Select
            items={Object.fromEntries(weights.map((w) => [String(w), WEIGHT_LABEL[w] ?? String(w)]))}
            value={String(weights.includes(layer.fontWeight) ? layer.fontWeight : weights[0])}
            onValueChange={(v) => onPatch({ fontWeight: Number(v) })}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weights.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {WEIGHT_LABEL[w] ?? w}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <NumberField label="字号" value={layer.fontSize} min={4} max={1000} onCommit={(fontSize) => onPatch({ fontSize })} />
        </Row>
        <ColorField value={layer.fill} onCommit={(fill) => onPatch({ fill })} label="文字颜色" />
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            value={[layer.align]}
            onValueChange={(v: string[]) => {
              const a = v[0];
              if (a === "left" || a === "center" || a === "right") onPatch({ align: a });
            }}
          >
            <ToggleGroupItem value="left" aria-label="左对齐">
              <AlignLeft />
            </ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="居中">
              <AlignCenter />
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="右对齐">
              <AlignRight />
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            multiple
            value={decoration}
            onValueChange={(v: string[]) =>
              onPatch({
                fontStyle: v.includes("italic") ? "italic" : "normal",
                textDecoration: v.includes("line-through")
                  ? "line-through"
                  : v.includes("underline")
                    ? "underline"
                    : "none",
                textTransform: v.includes("uppercase") ? "uppercase" : "none",
              })
            }
          >
            <ToggleGroupItem value="italic" aria-label="斜体">
              <Italic />
            </ToggleGroupItem>
            <ToggleGroupItem value="underline" aria-label="下划线">
              <Underline />
            </ToggleGroupItem>
            <ToggleGroupItem value="line-through" aria-label="删除线">
              <Strikethrough />
            </ToggleGroupItem>
            <ToggleGroupItem value="uppercase" aria-label="全大写">
              <CaseUpper />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Row>
          <NumberField label="行高" value={layer.lineHeight} step={0.05} precision={2} min={0.5} max={3} onCommit={(lineHeight) => onPatch({ lineHeight })} />
          <NumberField label="字距" value={layer.letterSpacing} step={0.5} precision={1} min={-50} max={200} onCommit={(letterSpacing) => onPatch({ letterSpacing })} />
        </Row>
      </Section>
      <Section
        title="描边"
        action={
          <Switch
            size="sm"
            checked={Boolean(layer.stroke)}
            onCheckedChange={(on) => onPatch({ stroke: on ? { color: "#1F1B16", width: 4 } : null })}
          />
        }
      >
        {layer.stroke && (
          <Row>
            <ColorField value={layer.stroke.color} onCommit={(color) => layer.stroke && onPatch({ stroke: { ...layer.stroke, color } })} label="描边色" />
            <NumberField label="粗" value={layer.stroke.width} min={0} max={50} onCommit={(width) => layer.stroke && onPatch({ stroke: { ...layer.stroke, width } })} />
          </Row>
        )}
      </Section>
      <Section
        title="阴影"
        action={
          <Switch
            size="sm"
            checked={Boolean(layer.shadow)}
            onCheckedChange={(on) =>
              onPatch({ shadow: on ? { color: "#00000066", blur: 16, offsetX: 0, offsetY: 6 } : null })
            }
          />
        }
      >
        {layer.shadow && (
          <>
            <ColorField value={layer.shadow.color} onCommit={(color) => layer.shadow && onPatch({ shadow: { ...layer.shadow, color: color + layer.shadow.color.slice(7) } })} label="阴影色" />
            <Row className="grid-cols-3">
              <NumberField label="糊" value={layer.shadow.blur} min={0} max={100} onCommit={(blur) => layer.shadow && onPatch({ shadow: { ...layer.shadow, blur } })} />
              <NumberField label="X" value={layer.shadow.offsetX} min={-200} max={200} onCommit={(offsetX) => layer.shadow && onPatch({ shadow: { ...layer.shadow, offsetX } })} />
              <NumberField label="Y" value={layer.shadow.offsetY} min={-200} max={200} onCommit={(offsetY) => layer.shadow && onPatch({ shadow: { ...layer.shadow, offsetY } })} />
            </Row>
          </>
        )}
      </Section>
    </>
  );
}

const WEIGHT_LABEL: Record<number, string> = {
  100: "Thin 100",
  200: "ExtraLight 200",
  300: "Light 300",
  400: "Regular 400",
  500: "Medium 500",
  600: "SemiBold 600",
  700: "Bold 700",
  800: "ExtraBold 800",
  900: "Black 900",
};

function ImageProps({
  layer,
  onPatch,
  actions,
}: {
  layer: ImageLayer;
  onPatch: (p: LayerPatch) => void;
  actions: LayerActions;
}) {
  const [prompt, setPrompt] = useState(layer.generation?.prompt ?? "");
  const [useCurrent, setUseCurrent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const generating = layer.status === "generating";

  const restore = (index: number) => {
    const entry = layer.history[index];
    if (!entry || !layer.src) return;
    // 当前图与选中的历史版本互换：当前图进历史首位
    const rest = layer.history.filter((_, i) => i !== index);
    onPatch({
      src: entry.src,
      history: [
        { src: layer.src, prompt: layer.generation?.prompt ?? "", createdAt: new Date().toISOString() },
        ...rest,
      ].slice(0, 5),
    });
  };

  return (
    <>
      <Section title="图片">
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            value={[layer.role]}
            onValueChange={(v: string[]) => {
              const r = v[0];
              if (r === "element" || r === "background") onPatch({ role: r });
            }}
          >
            <ToggleGroupItem value="element" className="px-2.5 text-xs">
              透明元素
            </ToggleGroupItem>
            <ToggleGroupItem value="background" className="px-2.5 text-xs">
              背景
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex gap-1">
            <Toggle size="sm" variant="outline" pressed={layer.flipX} onPressedChange={(flipX) => onPatch({ flipX })} aria-label="水平翻转">
              <FlipHorizontal2 />
            </Toggle>
            <Toggle size="sm" variant="outline" pressed={layer.flipY} onPressedChange={(flipY) => onPatch({ flipY })} aria-label="垂直翻转">
              <FlipVertical2 />
            </Toggle>
          </div>
        </div>
      </Section>
      <Section title="生成">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="描述这个图层要画什么，例如：isolated red sneaker, 3/4 view, soft studio light, on a transparent background"
          className="min-h-20 resize-y text-xs leading-relaxed"
        />
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          以当前图为参考（做变体）
          <Switch size="sm" checked={useCurrent} disabled={!layer.src} onCheckedChange={setUseCurrent} />
        </label>
        {generating && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin text-agent" />
            {layer.generation?.operation === "decompose"
              ? "正在拆分，完成后替换成底图和子图层"
              : "正在生成，完成后自动替换，旧图进历史"}
          </p>
        )}
        {layer.status === "error" && layer.generation?.error && (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {layer.generation.error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            // 生成中也允许重新提交：后端按 jobId 丢弃旧结果，这也是卡住时唯一的恢复入口
            disabled={!prompt.trim() || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await actions.regenerate(layer.id, prompt.trim(), useCurrent);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="animate-spin" /> : <Wand2 />}
            {generating ? "重新提交" : layer.src ? "重新生成" : "生成"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!layer.src || generating}
            onClick={() => actions.split(layer.id)}
            title="让 Agent 把这张图拆成可编辑的子图层"
          >
            <Scissors />
            拆分
          </Button>
        </div>
      </Section>
      {layer.history.length > 0 && (
        <Section title={`历史版本 · ${layer.history.length}`}>
          <div className="grid grid-cols-5 gap-1.5">
            {layer.history.map((h, i) => (
              <button
                key={h.src}
                type="button"
                title={h.prompt}
                disabled={generating}
                onClick={() => restore(i)}
                className={cn(
                  "aspect-square overflow-hidden rounded-md bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-size-[10px_10px] ring-1 ring-border transition hover:ring-2 hover:ring-selection disabled:opacity-50",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- CDN 上的用户生成图，不走 next/image 优化 */}
                <img src={h.src} alt="" className="size-full object-contain" />
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">点缩略图切回那一版，当前图会进历史。</p>
        </Section>
      )}
    </>
  );
}

function MultiProps({
  store,
  doc,
  layers,
}: {
  store: DesignStore;
  doc: DesignDocument;
  layers: Layer[];
}) {
  const left = Math.min(...layers.map((l) => l.x));
  const top = Math.min(...layers.map((l) => l.y));
  const right = Math.max(...layers.map((l) => l.x + l.width));
  const bottom = Math.max(...layers.map((l) => l.y + l.height));
  const align = (fn: (l: Layer) => LayerPatch) =>
    store.apply([{ type: "update_layers", updates: layers.map((l) => ({ id: l.id, patch: fn(l) })) }]);
  const items = [
    { icon: AlignStartVertical, label: "左对齐", fn: () => align(() => ({ x: left })) },
    { icon: AlignCenterVertical, label: "水平居中", fn: () => align((l) => ({ x: (left + right) / 2 - l.width / 2 })) },
    { icon: AlignEndVertical, label: "右对齐", fn: () => align((l) => ({ x: right - l.width })) },
    { icon: AlignStartHorizontal, label: "顶对齐", fn: () => align(() => ({ y: top })) },
    { icon: AlignCenterHorizontal, label: "垂直居中", fn: () => align((l) => ({ y: (top + bottom) / 2 - l.height / 2 })) },
    { icon: AlignEndHorizontal, label: "底对齐", fn: () => align((l) => ({ y: bottom - l.height })) },
  ];
  return (
    <>
      <Section title="对齐">
        <div className="grid grid-cols-6 gap-1">
          {items.map(({ icon: Icon, label, fn }) => (
            <Button key={label} variant="outline" size="icon-sm" onClick={fn} aria-label={label} title={label}>
              <Icon />
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() =>
            align((l) => ({
              x: (doc.canvas.width - (right - left)) / 2 + (l.x - left),
            }))
          }
        >
          整体在画布内水平居中
        </Button>
      </Section>
    </>
  );
}
