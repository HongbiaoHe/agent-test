import { useQueryClient } from "@tanstack/react-query";
import { AppWindow, FolderOpen, FolderSearch, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isVideoProjectPath, useOpenVideoEditor } from "@/features/video-editor";
import { useFileViewer } from "@/features/viewer/viewer-context";
import { cn } from "@/lib/utils";

import type { WorkspacePermission } from "../../../../../shared/workspace";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";

/**
 * 右上角「工作区文件」按钮 + 右侧面板（桌面端对应 Web 的 SandboxStatusButton）：
 * 左文件树（按目录懒加载）、右选中文件预览。工作区是这个会话自选的本机目录，
 * 没有沙箱的开机 / 心跳概念，改为显示目录路径与权限档位，并可在访达中打开。
 */
export function WorkspaceFilesButton({
  conversationId,
  workspaceDir,
  permission,
}: {
  conversationId: string;
  workspaceDir: string;
  permission: WorkspacePermission;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
  const viewer = useFileViewer();
  const openVideoEditor = useOpenVideoEditor();
  const abs = (rel: string) => `${workspaceDir.replace(/\/$/, "")}/${rel}`;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sandbox-dir", conversationId] });
    void qc.invalidateQueries({ queryKey: ["sandbox-file", conversationId] });
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.workspace.files")}
              onClick={() => {
                refresh();
                setOpen(true);
              }}
            />
          }
        >
          <FolderOpen />
        </TooltipTrigger>
        <TooltipContent>{t("chat.workspace.files")}</TooltipContent>
      </Tooltip>

      <Sheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className={cn(
            "w-full gap-0 transition-[max-width] duration-300",
            selected ? "data-[side=right]:sm:max-w-2xl" : "data-[side=right]:sm:max-w-sm",
          )}
        >
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2">
              <FolderOpen className="size-4" />
              {t("chat.workspace.title")}
              <Badge variant="secondary">{t(`chat.permission.label.${permission}`)}</Badge>
            </SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" title={workspaceDir}>
              {workspaceDir}
            </SheetDescription>
            <div className="flex gap-1.5">
              <Button variant="outline" size="xs" onClick={refresh}>
                <RefreshCw />
                {t("common.refresh")}
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void window.desktop.showInFolder(workspaceDir)}
              >
                <FolderSearch />
                {t("chat.workspace.openInFinder")}
              </Button>
            </div>
          </SheetHeader>
          <div className="flex min-h-0 flex-1">
            <ScrollArea
              className={cn("min-h-0", selected ? "w-64 shrink-0 border-r max-sm:hidden" : "flex-1")}
            >
              <div className="p-2">
                <FileTree
                  conversationId={conversationId}
                  selected={selected}
                  onSelect={(path) => {
                    // 剪辑工程：进剪辑器视图，不走文件预览
                    if (openVideoEditor && isVideoProjectPath(path)) {
                      setOpen(false);
                      setSelected(null);
                      openVideoEditor({ conversationId, path });
                      return;
                    }
                    setSelected(path);
                  }}
                />
              </div>
            </ScrollArea>
            {selected && (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
                  <span className="truncate font-mono text-xs">{selected}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {/* HTML 入口：以可交互网页打开（与 agent 的 preview_page 同一个弹窗） */}
                    {viewer && /\.html?$/i.test(selected) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("chat.workspace.previewPage")}
                        title={t("chat.workspace.previewPage")}
                        onClick={() =>
                          viewer.show({
                            source: "site",
                            spec: { kind: "file", path: selected, title: selected.split("/").pop() ?? selected },
                          })
                        }
                      >
                        <AppWindow />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("common.showInFinder")}
                      title={t("common.showInFinder")}
                      onClick={() => void window.desktop.showInFolder(abs(selected))}
                    >
                      <FolderSearch />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("chat.workspace.closePreview")}
                      onClick={() => setSelected(null)}
                    >
                      <X />
                    </Button>
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <FilePreview
                    conversationId={conversationId}
                    path={selected}
                    onReveal={() => void window.desktop.showInFolder(abs(selected))}
                  />
                </ScrollArea>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
