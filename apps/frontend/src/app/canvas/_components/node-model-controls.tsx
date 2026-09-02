"use client";

import { Check, ChevronDown, Cpu, Loader2, Sparkles } from "lucide-react";
import { useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AigcModel, AigcModelParam } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  findAigcModel,
  selectableParams,
  useAigcModels,
} from "../_hooks/use-aigc-models";
import { CanvasEditorContext } from "./flow-canvas";

/**
 * 档位维度的英文标签：aigc 目录里的 label 是中文（"宽高比"/"分辨率"），
 * 而面板其余文案都是英文，混排会很别扭。只映射画布会碰到的几个维度，
 * 没映射到的（后台将来新增的维度）退回目录给的 label —— 不认识也照样能选。
 */
const PARAM_LABEL: Record<string, string> = {
  aspect_ratio: "Ratio",
  resolution: "Quality",
  duration: "Duration",
  with_audio: "Audio",
  thinking: "Thinking",
};

/** 可选维度未选值时的占位：不传该维度，由渠道自己的缺省决定。 */
const AUTO = "Auto";

function paramLabel(p: AigcModelParam): string {
  return PARAM_LABEL[p.param_type] ?? p.label ?? p.param_type;
}

/** 某维度当前**实际会用**的取值：选过且合法就用它，没选过则必填维度取第一个取值。 */
function effectiveValue(
  p: AigcModelParam,
  params: Record<string, string>,
): string {
  const v = params[p.param_type];
  if (v && p.options.some((o) => o.value === v)) return v;
  return p.input === "required" ? p.options[0].value : "";
}

/**
 * 生成节点的模型区：选模型、选档位、按一下就生成。
 *
 * 为什么显示的是「实际会用的值」而不是「用户存过的值」：节点新建时这三个字段都是空的，
 * 此时服务端会回落该类型的默认模型（目录第一个 + 各必填维度第一个取值）。
 * 面板照着同一规则显示，人看到的就是真会提交的那份，不必先点一遍才知道用的是什么。
 * 一旦动过任一处，选择就落成节点上的显式配置（update_node op，与改标题同一条保存链路）。
 */
export function NodeModelControls({
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
  const { readOnly, updateNode, generateNode } =
    useContext(CanvasEditorContext);
  const catalog = useAigcModels(mediaType);

  const models: { channel: string; model: AigcModel }[] = [];
  for (const c of catalog.data?.channels ?? []) {
    for (const m of c.models) models.push({ channel: c.channel, model: m });
  }

  // 生效的模型：节点选过的那个；没选过（或已下线）就是目录给的默认模型
  const fallback = catalog.data?.default ?? null;
  const activeChannel = findAigcModel(catalog.data, channel, model)
    ? channel
    : (fallback?.channel ?? null);
  const activeAlias = findAigcModel(catalog.data, channel, model)
    ? model
    : (fallback?.model ?? null);
  const active = findAigcModel(catalog.data, activeChannel, activeAlias);
  const activeParams = findAigcModel(catalog.data, channel, model)
    ? (params ?? {})
    : (fallback?.params ?? {});

  const disabled = readOnly || !active;

  /** 换模型：档位交给「实际会用的值」规则重算（旧模型的维度在新模型上多半不存在）。 */
  const pickModel = (nextChannel: string, nextModel: string) => {
    updateNode(nodeId, {
      mediaChannel: nextChannel,
      mediaModel: nextModel,
      mediaParams: {},
    });
  };

  /** 改档位：value 为空串表示这一维度不传（可选维度的 Auto）。 */
  const pickParam = (dim: string, value: string) => {
    if (!activeChannel || !activeAlias) return;
    const next: Record<string, string> = {};
    for (const p of active ? selectableParams(active) : []) {
      const v = p.param_type === dim ? value : activeParams[p.param_type];
      if (v) next[p.param_type] = v;
    }
    updateNode(nodeId, {
      mediaChannel: activeChannel,
      mediaModel: activeAlias,
      mediaParams: next,
    });
  };

  return (
    <div className="space-y-2 border-t border-border pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Picker
          icon={<Cpu className="size-3 shrink-0" aria-hidden />}
          label={
            catalog.isLoading
              ? "Loading models…"
              : (active?.display_name ?? active?.model_alias ?? "No model")
          }
          disabled={disabled}
          items={models.map((m) => ({
            key: `${m.channel}/${m.model.model_alias}`,
            label: m.model.display_name ?? m.model.model_alias,
            hint: m.channel,
            active:
              m.channel === activeChannel &&
              m.model.model_alias === activeAlias,
            onSelect: () => pickModel(m.channel, m.model.model_alias),
          }))}
        />

        {active &&
          selectableParams(active).map((p) => {
            const value = effectiveValue(p, activeParams);
            return (
              <Picker
                key={p.param_type}
                label={`${paramLabel(p)} ${value || AUTO}`}
                disabled={disabled}
                items={[
                  // 可选维度才给「不传」这一档：必填维度总得有个值
                  ...(p.input === "required"
                    ? []
                    : [
                        {
                          key: "__auto__",
                          label: AUTO,
                          hint: "Let the provider decide",
                          active: value === "",
                          onSelect: () => pickParam(p.param_type, ""),
                        },
                      ]),
                  ...p.options.map((o) => ({
                    key: o.value,
                    label: o.label || o.value,
                    active: o.value === value,
                    onSelect: () => pickParam(p.param_type, o.value),
                  })),
                ]}
              />
            );
          })}
      </div>

      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={disabled || busy}
        onClick={() => generateNode(nodeId)}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-3.5" aria-hidden />
        )}
        {busy ? "Generating…" : hasGeneration ? "Regenerate" : "Generate"}
      </Button>
    </div>
  );
}

interface PickerItem {
  key: string;
  label: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
}

/**
 * 紧凑下拉：一枚胶囊按钮 + 一层浮出的选项列表。
 *
 * 与输入框上的模型切换器（CanvasModelSwitcher）同一套做法：用一层透明 backdrop 处理
 * 「点外面关掉」，不在 effect 里 setState（Next16 的 set-state-in-effect 是 error 级）。
 * 面板本身已在 NodeToolbar 里，故下拉相对定位在按钮下方即可。
 */
function Picker({
  icon,
  label,
  items,
  disabled,
}: {
  icon?: React.ReactNode;
  label: string;
  items: PickerItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled || items.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex max-w-56 shrink-0 items-center gap-1 rounded-md bg-muted/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors",
          !disabled && items.length > 0 && "hover:bg-accent hover:text-foreground",
          disabled && "opacity-60",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            className="absolute top-full left-0 z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={it.active}
                onClick={() => {
                  it.onSelect();
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  it.active ? "bg-accent" : "hover:bg-accent",
                )}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    it.active ? "text-primary opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">
                    {it.label}
                  </span>
                  {it.hint && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {it.hint}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
