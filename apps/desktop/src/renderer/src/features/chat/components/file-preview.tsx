"use client";

import { useQuery } from "@tanstack/react-query";
import { FileWarning, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { fetchSandboxFile } from "@/lib/api";

import { CodeViewer } from "./highlight";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 通用文件预览（桌面端版本）：按 path 拉 workspace.read，按三态渲染——
 *  - text：CodeViewer（按扩展名/内容高亮；本机读出的是原文，不剥行号）
 *  - image：base64 dataUrl 内联 <img>
 *  - binary（含音视频）：不可预览占位 + 字节数 + 「在访达中显示」
 * 仅负责内容区；外层文件名/关闭等 chrome 由调用方（workspace-panel）提供。
 */
export function FilePreview({
  conversationId,
  path,
  onReveal,
}: {
  conversationId: string;
  path: string;
  onReveal: () => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["sandbox-file", conversationId, path],
    queryFn: () => fetchSandboxFile(conversationId, path),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
        <FileWarning className="size-4 shrink-0" />
        {error instanceof Error ? error.message : t("chat.files.fileLoadFailed")}
      </div>
    );
  }

  if (data.kind === "image") {
    return (
      <div className="p-4">
        {/* dataUrl 为运行时 base64，next/image 无法优化，用原生 <img> */}
        <img
          src={data.dataUrl}
          alt={path}
          className="mx-auto max-h-[70vh] max-w-full rounded-lg border border-border object-contain"
        />
      </div>
    );
  }

  if (data.kind === "binary") {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
        <FileWarning className="size-5" />
        <p>{t("chat.files.cannotPreview")}</p>
        <p className="text-xs">{formatBytes(data.size)}</p>
        <Button variant="outline" size="sm" onClick={onReveal}>
          {t("common.showInFinder")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      <CodeViewer text={data.content} path={path} strip={false} />
      {data.truncated && (
        <p className="text-xs text-muted-foreground">
          {t("chat.files.truncated")}
        </p>
      )}
    </div>
  );
}
