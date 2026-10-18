"use client";

import { useQuery } from "@tanstack/react-query";
import { Eraser, ExternalLink, Globe, Loader2, RotateCw } from "lucide-react";
import { createContext, use, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createFilePreview,
  createPortPreview,
  keepAlivePreview,
  type PreviewGrant,
  revokePreview,
} from "@/lib/api";

import type { PreviewSpec } from "../_lib/thread";

/** 一次预览请求。nonce 让「同一页面再次预览」（agent 改完再调 preview_page）也能重签地址、重载。 */
export type PreviewTarget = PreviewSpec & { nonce: number };

/** 弹窗与卡片上展示的位置：文件给工作区路径，端口给 localhost:端口/路径。 */
export function previewLocation(spec: PreviewSpec): string {
  return spec.kind === "file"
    ? `/${spec.path}`
    : `localhost:${spec.port}${spec.path}`;
}

/**
 * 签发预览地址（两种预览走不同接口）。每次打开都请求一次，但 24 小时内同一内容服务端返回的是
 * 同一地址，所以重新打开时页面存储还在；重置后才换新地址。
 */
function signPreview(spec: PreviewSpec): Promise<PreviewGrant> {
  return spec.kind === "file"
    ? createFilePreview(spec.path)
    : createPortPreview(spec.port, spec.path);
}

/**
 * iframe sandbox：两种预览都在独立子域名 p-<id>.<基域名> 上，本来就与主站不同源，
 * 所以给 allow-same-origin——页面能正常用**自己的** localStorage / sessionStorage / IndexedDB /
 * cookie（agent 写的应用普遍依赖），却读不到主站的登录态与存储，对主站 API 的请求也按跨源处理。
 * 不给 allow-top-navigation：预览页不能把外层页面跳走。
 */
const PREVIEW_SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin";

/**
 * 打开预览的入口（由 AgentShell 提供）：消息流里的预览卡片、沙箱文件面板的「预览」按钮都走它，
 * 与 agent 主动触发共用同一个弹窗。不在 AgentShell 之下（拿到 null）时调用方隐藏入口。
 */
export const SitePreviewContext = createContext<
  ((spec: PreviewSpec) => void) | null
>(null);

export function useOpenSitePreview() {
  return use(SitePreviewContext);
}

/**
 * 沙箱网页预览弹窗：打开时现签短期地址，iframe 加载（隔离策略见 PREVIEW_SANDBOX）。
 * 预览地址本身就是访问凭证：iframe 与服务端都设 no-referrer，防它经 Referer 外泄。
 */
export function SitePreviewDialog({
  target,
  onClose,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  // 刷新：换 key 让 iframe 重新加载（响应 no-store，拿到的是沙箱里最新的文件）
  const [reloadKey, setReloadKey] = useState(0);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["site-preview", target?.nonce],
    // enabled 保证只在有 target 时执行；这里的分支只为让类型收窄
    queryFn: () =>
      target ? signPreview(target) : Promise.reject(new Error("no target")),
    enabled: !!target,
    // 不重试；关掉后不复用缓存（重开时再问服务端，24h 内它会给回同一地址）。
    // 打开期间**绝不自动重签**：重签会让 iframe 换地址重载，用户在页面里的操作状态全丢
    // （实测 staleTime:0 时窗口焦点/可见性变化就会触发，约 2s 一次）。
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [resetting, setResetting] = useState(false);

  // 心跳：弹窗开着就算在用。纯前端应用里点来点去可能一个请求都不发，只靠反代流量续期，
  // 沙箱会在用户操作中途闲置停机（E2B 实测：端口预览流量不会延长到期时间）
  const grantId = data?.id;
  useEffect(() => {
    if (!grantId) return;
    const timer = setInterval(() => {
      keepAlivePreview(grantId).catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [grantId]);

  /** 重置：作废当前地址并重新签发——新地址是新的源，页面从干净的存储开始。 */
  async function reset() {
    if (!grantId) return;
    setResetting(true);
    try {
      await revokePreview(grantId);
      await refetch();
      setReloadKey((k) => k + 1);
    } finally {
      setResetting(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-[90vw]">
        <DialogHeader className="flex-row items-center gap-3 border-b py-2.5 pr-12 pl-4">
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm">
              {target?.title ?? "Preview"}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">
              {target ? previewLocation(target) : ""}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reload preview"
              title="Reload"
              disabled={!data}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              <RotateCw />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reset preview"
              title="Reset: get a new address and start with clean storage"
              disabled={!data || resetting}
              onClick={() => void reset()}
            >
              {resetting ? <Loader2 className="animate-spin" /> : <Eraser />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open in new tab"
              title="Open in new tab"
              disabled={!data}
              nativeButton={false}
              render={
                <a href={data?.url} target="_blank" rel="noopener noreferrer" />
              }
            >
              <ExternalLink />
            </Button>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {isPending && !isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              Preparing preview…
            </div>
          ) : isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
              <p className="text-destructive">
                {error instanceof Error ? error.message : "Preview failed"}
              </p>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                <RotateCw />
                Retry
              </Button>
            </div>
          ) : data && target ? (
            <iframe
              key={reloadKey}
              src={data.url}
              title={target?.title ?? "Sandbox page preview"}
              className="h-full w-full rounded-b-xl border-0"
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
