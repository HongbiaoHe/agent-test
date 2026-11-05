import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderSearch, RefreshCw, X } from "lucide-react";
import { useState } from "react";

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
import { cn } from "@/lib/utils";

import type { WorkspacePermission } from "../../../../../shared/workspace";
import { PERMISSION_LABEL } from "./permission-switcher";
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
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
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
              aria-label="Workspace files"
              onClick={() => {
                refresh();
                setOpen(true);
              }}
            />
          }
        >
          <FolderOpen />
        </TooltipTrigger>
        <TooltipContent>Workspace files</TooltipContent>
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
              Workspace
              <Badge variant="secondary">{PERMISSION_LABEL[permission]}</Badge>
            </SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" title={workspaceDir}>
              {workspaceDir}
            </SheetDescription>
            <div className="flex gap-1.5">
              <Button variant="outline" size="xs" onClick={refresh}>
                <RefreshCw />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void window.desktop.showInFolder(workspaceDir)}
              >
                <FolderSearch />
                Open in Finder
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
                  onSelect={setSelected}
                />
              </div>
            </ScrollArea>
            {selected && (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
                  <span className="truncate font-mono text-xs">{selected}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Show in Finder"
                      title="Show in Finder"
                      onClick={() => void window.desktop.showInFolder(abs(selected))}
                    >
                      <FolderSearch />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close preview"
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
