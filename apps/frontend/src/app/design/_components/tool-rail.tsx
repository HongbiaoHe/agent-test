"use client";

import { Hand, ImageUp, Loader2, MousePointer2, Type, Wand2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { StageTool } from "./stage/design-stage";

/**
 * 画板左上的浮动工具条：选择 / 抓手 / 加文字 / 上传图片 / AI 生成图层（问题 11 的 text → layer：
 * 不经过 agent 对话，直接生成一个透明背景图层）。
 */
export function ToolRail({
  tool,
  onTool,
  onAddText,
  onUpload,
  onGenerateLayer,
}: {
  tool: StageTool;
  onTool: (t: StageTool) => void;
  onAddText: () => void;
  onUpload: (file: File) => Promise<void>;
  onGenerateLayer: (prompt: string, role: "element" | "background") => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [role, setRole] = useState<"element" | "background">("element");
  const [busy, setBusy] = useState(false);

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-sm">
      <RailButton label="选择 (V)" active={tool === "select"} onClick={() => onTool("select")}>
        <MousePointer2 />
      </RailButton>
      <RailButton label="抓手 (H / 按住空格)" active={tool === "hand"} onClick={() => onTool("hand")}>
        <Hand />
      </RailButton>
      <div className="my-1 h-px w-5 bg-border" />
      <RailButton label="文字 (T)" onClick={onAddText}>
        <Type />
      </RailButton>
      <RailButton label="上传图片（支持透明 PNG）" onClick={() => fileRef.current?.click()}>
        {uploading ? <Loader2 className="animate-spin" /> : <ImageUp />}
      </RailButton>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setUploading(true);
          try {
            await onUpload(file);
          } finally {
            setUploading(false);
          }
        }}
      />
      <Popover open={genOpen} onOpenChange={setGenOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon" aria-label="生成图层" className={cn(genOpen && "bg-accent text-accent-foreground")} />
                }
              />
            }
          >
            <Wand2 />
          </TooltipTrigger>
          <TooltipContent side="right">生成图层</TooltipContent>
        </Tooltip>
        <PopoverContent side="right" align="start" className="w-80 space-y-2.5 p-3">
          <div>
            <p className="text-sm font-semibold">生成一个图层</p>
            <p className="text-xs text-muted-foreground">不经过对话直接生成。元素会是透明背景，并自动裁掉四周空白。</p>
          </div>
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            value={[role]}
            onValueChange={(v: string[]) => {
              if (v[0] === "element" || v[0] === "background") setRole(v[0]);
            }}
            className="w-full"
          >
            <ToggleGroupItem value="element" className="flex-1 text-xs">
              透明元素
            </ToggleGroupItem>
            <ToggleGroupItem value="background" className="flex-1 text-xs">
              整幅背景
            </ToggleGroupItem>
          </ToggleGroup>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            autoFocus
            placeholder={role === "element" ? "一片金黄的银杏叶，微微卷曲，柔和侧光" : "清晨的奶油色咖啡馆桌面，柔焦，右侧留白"}
            className="text-sm"
          />
          <Button
            className="w-full"
            disabled={!prompt.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onGenerateLayer(prompt.trim(), role);
                setPrompt("");
                setGenOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            生成
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(active && "bg-accent text-accent-foreground")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
