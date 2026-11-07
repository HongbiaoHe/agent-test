"use client";

import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ModePreview } from "@/lib/api";

const KIND_LABEL: Record<ModePreview["unavailable"][number]["kind"], string> = {
  tool: "Tool",
  mcp_server: "Connector",
  skill: "Skill",
};

/** 最终提示词预览：后端按固定顺序拼好的 system prompt 原文 + 本环境不可用的勾选项清单。 */
export function PromptPreviewDialog({
  preview,
  onClose,
}: {
  preview: ModePreview | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(48rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>Final prompt</DialogTitle>
          <DialogDescription>
            Exactly what the model receives as its system prompt: your text with
            placeholders expanded, followed by the tool and environment sections.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {preview && preview.unavailable.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/40 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <TriangleAlert className="size-4 text-warning" />
                Not available in this environment
              </p>
              <ul className="space-y-1">
                {preview.unavailable.map((u) => (
                  <li
                    key={`${u.kind}:${u.name}`}
                    className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Badge variant="outline">{KIND_LABEL[u.kind]}</Badge>
                    <span className="font-mono text-foreground">{u.name}</span>
                    <span>— {u.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <pre className="rounded-lg border bg-card px-4 py-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {preview?.systemPrompt}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}
