"use client";

import type { DesignDocument } from "@agent-test/design-schema";
import { CircleAlert, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { canExportAt, downloadBlob, exportPsd, exportRaster, type RasterFormat } from "../_lib/render";

type Format = RasterFormat | "psd";

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: "png", label: "PNG", hint: "无损；透明底保留 alpha" },
  { value: "jpeg", label: "JPG", hint: "体积小；透明区域填白" },
  { value: "webp", label: "WebP", hint: "适合网页" },
  { value: "psd", label: "PSD", hint: "分层，文字可在 Photoshop 里改" },
];

/** 顶栏右上角的导出（问题 13 / 14）：格式 + 倍率 → 下载。全部在前端离屏渲染，所见即所得。 */
export function ExportMenu({ doc, title }: { doc: DesignDocument; title: string }) {
  const [format, setFormat] = useState<Format>("png");
  const [ratio, setRatio] = useState(2);
  const [busy, setBusy] = useState(false);
  const generating = doc.layers.some((l) => l.type === "image" && l.status === "generating");
  const name = (title || "design").replace(/[\\/:*?"<>|]/g, "_");

  const run = async () => {
    setBusy(true);
    try {
      if (format === "psd") {
        downloadBlob(await exportPsd(doc), `${name}.psd`);
      } else {
        const ext = format === "jpeg" ? "jpg" : format;
        downloadBlob(await exportRaster(doc, format, ratio), `${name}@${ratio}x.${ext}`);
      }
    } catch (e) {
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" />}>
        <Download />
        导出
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">格式</p>
          <div className="grid grid-cols-2 gap-1.5">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFormat(f.value)}
                className={
                  f.value === format
                    ? "rounded-lg border border-foreground/30 bg-accent px-2.5 py-2 text-left"
                    : "rounded-lg border border-border px-2.5 py-2 text-left hover:bg-muted"
                }
              >
                <div className="text-sm font-semibold">{f.label}</div>
                <div className="text-[10px] leading-snug text-muted-foreground">{f.hint}</div>
              </button>
            ))}
          </div>
        </div>
        {format !== "psd" && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">倍率</p>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[String(ratio)]}
              onValueChange={(v: string[]) => v[0] && setRatio(Number(v[0]))}
              className="w-full"
            >
              {[1, 2, 3].map((r) => (
                <ToggleGroupItem key={r} value={String(r)} disabled={!canExportAt(doc, r)} className="flex-1">
                  {r}x
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {doc.canvas.width * ratio} × {doc.canvas.height * ratio} px
            </p>
          </div>
        )}
        {generating && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            还有图层在生成中，导出的是它们当前的样子。
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          下载 {FORMATS.find((f) => f.value === format)?.label}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
