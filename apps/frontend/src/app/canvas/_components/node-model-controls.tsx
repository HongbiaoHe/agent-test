"use client";

import {
  Check,
  ChevronDown,
  Cpu,
  Info,
  Loader2,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AigcModel, AigcModelParam } from "@/lib/api";
import { cn } from "@/lib/utils";

import { findAigcModel, useAigcModels } from "../_hooks/use-aigc-models";
import {
  AUTO,
  derivedDims,
  hasOwnAuto,
  optionText,
  orderedParams,
  paramLabel,
  resolveParams,
  sortedOptions,
  type ResolvedParams,
} from "../_lib/aigc-params";
import { CanvasEditorContext } from "./flow-canvas";

/**
 * 节点当前「生效」的模型与档位：节点选过的那个；没选过（或已下线）就是目录给的默认模型。
 * 档位按目录 constraints + 上游输入收窄过——显示的就是真会提交的那份。
 * 模型区与 Generate 按钮各自要用（两者不在同一行渲染），目录走 react-query 缓存，不会重复请求。
 */
function useActiveModel(
  nodeId: string,
  mediaType: "image" | "video",
  channel: string | null,
  model: string | null,
  params: Record<string, string> | null,
) {
  const { resolveInputs } = useContext(CanvasEditorContext);
  const catalog = useAigcModels(mediaType);
  const chosen = findAigcModel(catalog.data, channel, model);
  const fallback = catalog.data?.default ?? null;
  const activeChannel = chosen ? channel : (fallback?.channel ?? null);
  const activeAlias = chosen ? model : (fallback?.model ?? null);
  const active = findAigcModel(catalog.data, activeChannel, activeAlias);
  const derived = active ? derivedDims(resolveInputs(nodeId), active) : {};
  const requested = chosen ? (params ?? {}) : (fallback?.params ?? {});
  return {
    catalog,
    activeChannel,
    activeAlias,
    active,
    derived,
    resolved: active ? resolveParams(active, requested, derived) : null,
  };
}

/**
 * 生成节点的模型区：一枚模型选择 + 一枚档位摘要（`Reference · 16:9 · 720p · 5s · 🔊`）。
 * 点摘要弹出档位面板，该模型支持的维度各一排分段选择；此刻选不了的取值置灰。
 * 触发生成的按钮在面板底栏（见 NodeGenerateButton）。
 *
 * 为什么显示的是「实际会用的值」而不是「用户存过的值」：节点新建时这三个字段都是空的，
 * 此时服务端会回落该类型的默认模型（目录第一个 + 各必填维度第一个取值），提交前还会按
 * constraints 收窄。面板照着同一规则显示，人看到的就是真会提交的那份。
 * 一旦动过任一处，选择就落成节点上的显式配置（update_node op，与改标题同一条保存链路）。
 */
export function NodeModelControls({
  nodeId,
  mediaType,
  channel,
  model,
  params,
}: {
  nodeId: string;
  mediaType: "image" | "video";
  channel: string | null;
  model: string | null;
  params: Record<string, string> | null;
}) {
  const { readOnly, updateNode } = useContext(CanvasEditorContext);
  const { catalog, activeChannel, activeAlias, active, derived, resolved } =
    useActiveModel(nodeId, mediaType, channel, model, params);

  const disabled = readOnly || !active;

  /** 换模型：档位交给「实际会用的值」规则重算（旧模型的维度在新模型上多半不存在）。 */
  const pickModel = (nextChannel: string, nextModel: string) => {
    updateNode(nodeId, {
      mediaChannel: nextChannel,
      mediaModel: nextModel,
      mediaParams: {},
    });
  };

  /**
   * 改档位：value 为空串表示这一维度不传（可选维度的 Auto）。
   * 存之前按 constraints 收窄一遍——改一个维度可能连带改另一个（Veo 选 1080p → 时长只剩 8s），
   * 存下来的与面板显示的保持同一份。
   */
  const pickParam = (dim: string, value: string) => {
    if (!active || !activeChannel || !activeAlias || !resolved) return;
    const next = { ...resolved.values };
    if (value) next[dim] = value;
    else delete next[dim];
    updateNode(nodeId, {
      mediaChannel: activeChannel,
      mediaModel: activeAlias,
      mediaParams: resolveParams(active, next, derived).values,
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1 border-t border-border pt-2.5">
      <ModelPicker
        loading={catalog.isLoading}
        channels={catalog.data?.channels ?? []}
        active={active}
        activeChannel={activeChannel}
        disabled={disabled}
        onPick={pickModel}
      />
      {active && resolved && (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          <ParamsPicker
            model={active}
            mediaType={mediaType}
            resolved={resolved}
            disabled={disabled}
            onPick={pickParam}
          />
        </>
      )}
    </div>
  );
}

/**
 * 面板底栏右端的生成按钮。和模型区分开渲染：放在底栏里与「类型 / 上游来源」同排，
 * 主操作落在面板右下角——读完提示词、看完档位，视线自然停在那里。
 */
export function NodeGenerateButton({
  nodeId,
  mediaType,
  channel,
  model,
  params,
  hasGeneration,
  busy,
}: {
  nodeId: string;
  mediaType: "image" | "video";
  channel: string | null;
  model: string | null;
  params: Record<string, string> | null;
  /** 已经生成过一版：按钮改叫 Regenerate（会新起一次生成，历史版本仍在） */
  hasGeneration: boolean;
  /** 这一版正在排队 / 生成中：按钮转圈并禁用，避免重复触发 */
  busy: boolean;
}) {
  const { readOnly, generateNode } = useContext(CanvasEditorContext);
  const { active } = useActiveModel(nodeId, mediaType, channel, model, params);

  return (
    <Button
      type="button"
      size="sm"
      disabled={readOnly || !active || busy}
      onClick={() => generateNode(nodeId)}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Sparkles className="size-3.5" aria-hidden />
      )}
      {busy ? "Generating…" : hasGeneration ? "Regenerate" : "Generate"}
    </Button>
  );
}

/** 模型区两枚触发器的共同外观：无底色的文字按钮，hover / 展开时才铺底 */
const TRIGGER =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors duration-150 hover:bg-accent disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-accent";

function ModelPicker({
  loading,
  channels,
  active,
  activeChannel,
  disabled,
  onPick,
}: {
  loading: boolean;
  channels: { channel: string; models: AigcModel[] }[];
  active: AigcModel | null;
  activeChannel: string | null;
  disabled: boolean;
  onPick: (channel: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = loading
    ? "Loading models…"
    : (active?.display_name ?? active?.model_alias ?? "No model");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        title="Model"
        className={cn(TRIGGER, "shrink-0 font-medium")}
      >
        <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="max-w-36 truncate">{name}</span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent className="nowheel max-h-[min(24rem,var(--available-height))] w-60">
        {/* 按渠道分组：同一家的几个版本挨在一起，比每行挂一个渠道副标题好扫 */}
        {channels.map((c) => (
          <div key={c.channel} role="group" aria-label={c.channel}>
            <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
              {c.channel}
            </div>
            {c.models.map((m) => {
              const selected =
                c.channel === activeChannel &&
                m.model_alias === active?.model_alias;
              return (
                <button
                  key={m.model_alias}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onPick(c.channel, m.model_alias);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors",
                    selected ? "bg-accent" : "hover:bg-accent",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {m.display_name ?? m.model_alias}
                  </span>
                  {selected && (
                    <Check className="size-3.5 shrink-0" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 生成方式：参考图以什么 role 提交。目前只开放「参考」，首尾帧置灰——
 * aigc 目录不透出模型的 role 能力，选错会在接单时整单被拒。
 * 显示的是后端真会用的 role（目录里的 ref_role）：少数只认首帧的模型会亮在首尾帧那格。
 */
const MODE_OPTIONS = [
  { value: "first_frame", label: "First/last frame", short: "Frames" },
  { value: "reference", label: "Reference", short: "Reference" },
] as const;

/** 不在固定三项（比例 / 清晰度 / 时长）里的维度：摘要里带上维度名，否则光看取值认不出 */
function showsName(p: AigcModelParam): boolean {
  return !["aspect_ratio", "resolution", "duration"].includes(p.param_type);
}

/** 某维度当前取值的展示文本；没传（可选维度的 Auto）时为 Auto */
function valueText(p: AigcModelParam, value: string | undefined): string {
  const o =
    value === undefined ? null : p.options.find((x) => x.value === value);
  return o ? optionText(o) : AUTO;
}

/** 档位摘要 + 档位面板 */
function ParamsPicker({
  model,
  mediaType,
  resolved,
  disabled,
  onPick,
}: {
  model: AigcModel;
  mediaType: "image" | "video";
  resolved: ResolvedParams;
  disabled: boolean;
  onPick: (dim: string, value: string) => void;
}) {
  const dims = orderedParams(model);
  // last_frame 与 first_frame 归在同一格「首尾帧」
  const mode =
    mediaType === "video"
      ? model.ref_role === "reference" || !model.ref_role
        ? "reference"
        : "first_frame"
      : null;

  // 摘要：模式 · 各维度取值，音频单独用一枚图标收尾（一眼看出开没开声音）
  const parts: string[] = [];
  if (mode) {
    const short = MODE_OPTIONS.find((o) => o.value === mode)?.short;
    if (short) parts.push(short);
  }
  let audio: string | null = null;
  for (const p of dims) {
    if (resolved.forbid.has(p.param_type)) continue;
    const text = valueText(p, resolved.values[p.param_type]);
    if (p.param_type === "with_audio") audio = text;
    else parts.push(showsName(p) ? `${paramLabel(p)} ${text}` : text);
  }

  if (dims.length === 0 && !mode) return null;

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        title="Generation settings"
        className={cn(TRIGGER, "tabular-nums")}
      >
        <span className="truncate">
          {parts.map((t, i) => (
            <span key={`${i}-${t}`}>
              {i > 0 && (
                <span aria-hidden className="px-1 text-muted-foreground">
                  ·
                </span>
              )}
              {t}
            </span>
          ))}
        </span>
        {audio && (
          <span
            className="flex shrink-0 items-center gap-1"
            title={`Audio: ${audio}`}
          >
            {parts.length > 0 && (
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
            )}
            {audio === "Off" ? (
              <VolumeX className="size-3.5" aria-label="Audio off" />
            ) : (
              <Volume2
                className={cn("size-3.5", audio === AUTO && "opacity-50")}
                aria-label={`Audio ${audio}`}
              />
            )}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent className="nowheel w-80 space-y-3 p-3">
        {mode && (
          <Section
            label="Mode"
            help="Reference: upstream images guide the subject and style. First/last frame is not available yet."
            note={
              mode === "first_frame"
                ? "This model only takes the upstream image as its first frame."
                : undefined
            }
          >
            <Segmented
              cols={2}
              items={MODE_OPTIONS.map((o) => ({
                key: o.value,
                label: o.label,
                selected: o.value === mode,
                // 首尾帧暂不开放；参考是唯一可选项，点了也不会变
                disabled: o.value === "first_frame",
                onSelect: () => {},
              }))}
            />
          </Section>
        )}
        {dims.map((p) => (
          <ParamSection
            key={p.param_type}
            param={p}
            resolved={resolved}
            onPick={onPick}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ParamSection({
  param: p,
  resolved,
  onPick,
}: {
  param: AigcModelParam;
  resolved: ResolvedParams;
  onPick: (dim: string, value: string) => void;
}) {
  const dim = p.param_type;
  const forbidden = resolved.forbid.has(dim);
  const allowed = resolved.allow.get(dim);
  const value = resolved.values[dim] ?? "";
  const ratio = dim === "aspect_ratio";
  const ownAuto = hasOwnAuto(p);
  // 可选维度才给「不传」这一档（必填维度总得有个值）；目录自带 Auto 时不再补
  const synthAuto = p.input !== "required" && !ownAuto;

  const items: SegmentItem[] = [
    ...(synthAuto
      ? [
          {
            key: "__auto__",
            label: AUTO,
            glyph: ratio ? <RatioGlyph text="" /> : undefined,
            selected: !forbidden && value === "",
            disabled: forbidden,
            onSelect: () => onPick(dim, ""),
          },
        ]
      : []),
    ...sortedOptions(p).map((o) => {
      const text = optionText(o);
      return {
        key: o.value,
        label: text,
        glyph: ratio ? <RatioGlyph text={text} /> : undefined,
        // 没选过的可选维度显示为 Auto：目录自带的那档 Auto 就该亮着
        selected:
          !forbidden &&
          (o.value === value || (value === "" && ownAuto && text === AUTO)),
        disabled:
          forbidden ||
          (allowed !== undefined && !allowed.includes(o.value)),
        onSelect: () => onPick(dim, o.value),
      };
    }),
  ];

  const limited = !forbidden && items.some((i) => i.disabled);

  return (
    <Section
      label={paramLabel(p)}
      note={
        forbidden
          ? "Not used with the current inputs"
          : limited
            ? "Some options are limited by your other settings or inputs"
            : undefined
      }
    >
      <Segmented
        cols={columnsFor(items.length, ratio)}
        items={items}
        tall={ratio}
      />
    </Section>
  );
}

/** 每排几格：少的一排放下，多的（时长 30 档、比例 14 档）折成规整的几排 */
function columnsFor(n: number, ratio: boolean): number {
  if (n <= 4) return n;
  if (ratio) return n <= 6 ? 3 : 5;
  if (n <= 6) return 3;
  if (n <= 12) return 4;
  return 6;
}

function Section({
  label,
  help,
  note,
  children,
}: {
  label: string;
  help?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 px-0.5 text-xs text-muted-foreground">
        {label}
        {help && (
          <Tooltip>
            <TooltipTrigger
              aria-label={`About ${label}`}
              className="flex size-4 items-center justify-center rounded-sm hover:text-foreground"
            >
              <Info className="size-3" aria-hidden />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-56">
              {help}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
      {note && (
        <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

interface SegmentItem {
  key: string;
  label: string;
  /** 标签上方的小示意（比例框） */
  glyph?: React.ReactNode;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}

/** grid-cols-* 需要静态类名才会被 Tailwind 收进产物 */
const COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
};

/**
 * 分段选择：一条凹槽里排开所有取值，选中的那格浮起来。
 * 比下拉好在「有哪些档、现在是哪档、哪些档此刻不能选」一眼全在，不用点开再找。
 */
function Segmented({
  cols,
  items,
  tall,
}: {
  cols: number;
  items: SegmentItem[];
  /** 带比例框的格子：图形在上、文字在下 */
  tall?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={cn("grid gap-0.5 rounded-lg bg-muted p-0.5", COLS[cols])}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.selected}
          disabled={it.disabled}
          title={
            it.disabled && !it.selected
              ? "Not available with current settings"
              : undefined
          }
          onClick={it.onSelect}
          className={cn(
            "flex min-w-0 items-center justify-center rounded-md px-1 text-xs tabular-nums transition-[background-color,color,box-shadow] duration-150",
            tall ? "h-12 flex-col gap-1" : "h-8",
            it.selected
              ? "bg-popover text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
            // 选中的那格即使不可改也保持原样：它表达的是「现在就是这个」，压暗会读成「没选」
            it.disabled && "cursor-not-allowed",
            it.disabled &&
              !it.selected &&
              "opacity-40 hover:text-muted-foreground",
          )}
        >
          {it.glyph}
          <span className="max-w-full truncate">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** "16:9" / "16x9" / "19.5:9" → [w, h]；adaptive / auto 之类返回 null */
function parseRatio(text: string): [number, number] | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/**
 * 比例的小示意框：长边贴满 size，短边按比例缩。
 * 「1:1 还是 9:16」看形状比读数字快——尤其提示词写着"竖屏"而档位是横的时候。
 * 认不出比例（Auto / Adaptive）时画一个虚线方框，表示「由渠道定」。
 */
function RatioGlyph({ text, size = 14 }: { text: string; size?: number }) {
  const r = parseRatio(text);
  const scale = r ? size / Math.max(r[0], r[1]) : 0;
  const w = r ? Math.max(3, Math.round(r[0] * scale)) : size - 2;
  const h = r ? Math.max(3, Math.round(r[1] * scale)) : size - 2;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          "rounded-[2px] border-[1.5px] border-current",
          !r && "border-dashed",
        )}
        style={{ width: w, height: h }}
      />
    </span>
  );
}
