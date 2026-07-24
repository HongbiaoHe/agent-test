"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Monitor, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { startSandboxDesktop, stopSandboxDesktop } from "@/lib/api";

/**
 * 沙箱图形桌面 Dialog（noVNC iframe，可查看可操作）。
 *
 * 生命周期（设计 §已确认的需求决策）：
 * - open → POST /sandbox/desktop 懒启动（幂等，首次拉起约 3-5s，期间显示骨架）；
 * - close → DELETE /sandbox/desktop 停桌面（fire-and-forget，失败静默——
 *   桌面进程随沙箱 5 分钟闲置 auto-stop 一并回收）。
 *
 * 已知交互：签名 URL 首访显示 Daytona「Preview URL Warning」拦截页，
 * 在 iframe 内点一次「I Understand, Continue」即可（Daytona 自家控制台同样如此）。
 */
export function DesktopDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["sandbox-desktop"],
    queryFn: () => startSandboxDesktop(),
    enabled: open,
    // 桌面地址一次性签发：不重试轮询、不缓存复用（关了重开要重新 start + 签 URL）
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        // 关闭即停桌面（收尾语义，不阻塞 UI、失败静默）
        if (!o) stopSandboxDesktop().catch(() => {});
      }}
    >
      <DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-[90vw]">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Monitor className="size-4" />
            Sandbox Desktop
          </DialogTitle>
          <DialogDescription className="text-xs">
            首次访问需在窗口内点一次 “I Understand, Continue”（Daytona
            预览域名提示）。关闭窗口将停止桌面会话。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {isFetching ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              正在启动桌面（首次约需几秒）…
            </div>
          ) : isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
              <p className="text-destructive">
                {error instanceof Error ? error.message : "桌面启动失败"}
              </p>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                <RotateCw />
                重试
              </Button>
            </div>
          ) : data ? (
            <iframe
              src={data.url}
              title="Sandbox desktop (noVNC)"
              className="h-full w-full border-0"
              // noVNC 需要键鼠与脚本；剪贴板放开便于桌面内复制粘贴
              allow="clipboard-read; clipboard-write"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
