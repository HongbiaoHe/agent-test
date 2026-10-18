"use client";

import { AppWindow, Globe, Server } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { PreviewSpec } from "../_lib/thread";
import { previewLocation, useOpenSitePreview } from "./site-preview";

/**
 * 网页预览卡片：agent 调 preview_page 后出现在消息流里（实时到达时弹窗已自动打开），
 * 关掉弹窗或刷新会话后可从这里再次打开。端口预览（运行中的服务）与静态页用不同图标区分。
 */
export function PreviewCard({ spec }: { spec: PreviewSpec }) {
  const openPreview = useOpenSitePreview();
  const Icon = spec.kind === "port" ? Server : Globe;

  return (
    <div className="flex max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{spec.title}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {previewLocation(spec)}
        </p>
      </div>
      {openPreview && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => openPreview(spec)}
        >
          <AppWindow />
          Preview
        </Button>
      )}
    </div>
  );
}
