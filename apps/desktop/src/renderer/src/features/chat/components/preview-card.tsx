import { AppWindow, Globe, Server } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { type PreviewSpec, previewLocation } from "@/features/viewer/preview-target";
import { useFileViewer } from "@/features/viewer/viewer-context";
import { agent } from "@/lib/agent-client";

import { parsePreviewResult } from "../lib/thread";

/**
 * 网页预览卡片（同 Web preview-card.tsx）：agent 调 preview_page 后出现在消息流里（实时到达时弹窗已自动打开），
 * 关掉弹窗或重开会话后可从这里再次打开。端口预览（运行中的服务）与静态页用不同图标区分。
 */
export function PreviewCard({ spec }: { spec: PreviewSpec }) {
  const { t } = useTranslation();
  const viewer = useFileViewer();
  const Icon = spec.kind === "port" ? Server : Globe;

  return (
    <div className="flex max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{spec.title}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{previewLocation(spec)}</p>
      </div>
      {viewer && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => viewer.show({ source: "site", spec })}
        >
          <AppWindow />
          {t("chat.preview.open")}
        </Button>
      )}
    </div>
  );
}

/**
 * agent 调 preview_page 成功时**实时**弹出预览（同 Web use-conversation 的 onPreview）。只看实时推来的 tool_end，
 * 回放历史不会弹。放在 FileViewerProvider 之内，与卡片、链接共用同一个预览弹窗。
 */
export function PreviewAutoOpen({ conversationId }: { conversationId: string }) {
  const viewer = useFileViewer();
  useEffect(() => {
    if (!viewer) return;
    return agent.subscribe((e) => {
      if (e.kind === "reconnected" || e.type !== "conversation" || e.conversationId !== conversationId) return;
      const { type, payload } = e.event;
      if (type !== "tool_end" || typeof payload !== "object" || payload === null) return;
      if (!("name" in payload) || payload.name !== "preview_page" || !("content" in payload)) return;
      const spec = parsePreviewResult(payload.content);
      if (spec) viewer.show({ source: "site", spec });
    });
  }, [viewer, conversationId]);
  return null;
}
