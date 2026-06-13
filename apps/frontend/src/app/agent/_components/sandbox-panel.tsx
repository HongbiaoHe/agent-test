"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Server, Timer, X } from "lucide-react";
import { useEffect, useState } from "react";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchSandboxStatus, type SandboxStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";

/**
 * 沙箱状态 → 展示语义（状态色 dot / 文案）。
 * 状态颜色靠彩色圆点表达：运行=绿、停机/未知=黄、无沙箱=中性灰——徽标本身保持中性底 +
 * 高对比文字（彩字弱底在浅色下对比度不足 WCAG，见 DESIGN.md §11）。dot 同时供顶栏心跳点复用。
 */
function toneOf(data: SandboxStatus | undefined) {
  if (!data?.exists) return { dot: "bg-muted-foreground/40", label: "No sandbox" };
  if (data.state === "started") return { dot: "bg-success", label: "Running" };
  if (data.state === "stopped") return { dot: "bg-warning", label: "Stopped" };
  return { dot: "bg-warning", label: data.state ?? "Unknown" };
}

/** 每秒跳动的当前时间（active=false 时不起 interval，面板关闭零开销）。 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function formatRemain(ms: number): string {
  if (ms <= 0) return "Reclaiming soon";
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * 沙箱状态按钮（心跳指示）+ 详情侧栏。
 * 自包含：内部轮询 GET /sandbox/status（15s），不依赖父级状态。
 * 查询只读、绝不唤醒停机沙箱（见后端 SandboxStatusService）。
 *
 * 心跳与文件列表分离：心跳轮询不带 files（后端只 list()，不产生 Daytona 活动
 * 事件——否则沙箱永不自动停机）；文件列表仅面板打开时单独 5s 轮询（?files=1）。
 */
export function SandboxStatusButton() {
  const [open, setOpen] = useState(false);
  // 当前预览的文件（虚拟相对路径）；非 null 时侧栏加宽为左树右预览
  const [selected, setSelected] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["sandbox-status"],
    queryFn: () => fetchSandboxStatus(),
    refetchInterval: 15_000,
    // React Query 默认窗口未聚焦就暂停 interval——Electron 预览/部分 WebView 的
    // focus 事件不标准会让轮询长期停摆（表现为「要刷新页面状态才变」）。
    // 这是 15s 级的轻量只读查询，后台照常轮询。
    refetchIntervalInBackground: true,
    // 沙箱状态属于环境信息，失败不该全局 toast 刷屏（providers 的 QueryCache onError
    // 用 toast id 去重，这里再加 meta 静默会引入分叉——直接依赖 exists:false 降级即可）
  });
  // 详情查询（含文件列表）：仅面板打开时启用，关闭即停（不在后台续命沙箱）
  const {
    data: detail,
    isFetching: detailFetching,
    refetch: refetchDetail,
  } = useQuery({
    // 仅刷新状态主体（state/时间戳/倒计时）；文件不再随此查询返回，改由文件树按目录懒加载
    queryKey: ["sandbox-status", "detail"],
    queryFn: () => fetchSandboxStatus(),
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  // 状态徽标优先用详情数据：打开后随详情刷新即时反映最新 state，不再滞后于 15s 心跳
  const tone = toneOf(detail ?? data);
  const running = data?.exists && data.state === "started";

  function openPanel() {
    setOpen(true);
    // 全局 staleTime=60s 会把 60s 内的缓存判定为 fresh——仅靠 enabled 翻转不会自动重拉，
    // 表现为「打开时状态/文件还是旧的」。这里显式 refetch 强制打开瞬间立即刷新状态+文件
    // 列表（命令式 refetch 忽略 staleTime；并发同 key 请求会被去重，不会多发）。
    void refetchDetail();
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sandbox status"
              onClick={openPanel}
            />
          }
        >
          <span className="relative">
            <Server />
            {/* 心跳点：运行中绿色 + ping 扩散动画；停机琥珀；无沙箱灰 */}
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2 rounded-full",
                tone.dot,
              )}
            />
            {running && (
              <span className="absolute -top-0.5 -right-0.5 size-2 animate-ping rounded-full bg-success/75" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>Sandbox: {tone.label}</TooltipContent>
      </Tooltip>

      <Sheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setSelected(null); // 关闭面板时清掉预览，下次打开回到纯文件树宽度
        }}
      >
        <SheetContent
          side="right"
          className={cn(
            "w-full gap-0 transition-[max-width] duration-300",
            // 预览文件时加宽，给代码留足阅读宽度；否则保持窄栏只放文件树
            selected
              ? "data-[side=right]:sm:max-w-2xl"
              : "data-[side=right]:sm:max-w-sm",
          )}
        >
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2">
              <Server className="size-4" />
              Sandbox
              <Badge variant="secondary" className="gap-1.5">
                <span className={cn("size-1.5 rounded-full", tone.dot)} />
                {tone.label}
              </Badge>
              {/* 刷新中（打开瞬间 / 5s 轮询）：旋转指示正在与沙箱同步状态+文件 */}
              {detailFetching && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
            </SheetTitle>
            <SheetDescription>
              Each user gets a dedicated sandbox; all conversations share the same workspace.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1">
            {/* 左：状态详情 + 文件树。预览时收窄为定宽侧列（移动端隐藏，腾给预览） */}
            <ScrollArea
              className={cn(
                "min-h-0",
                selected
                  ? "w-64 shrink-0 border-r max-sm:hidden"
                  : "flex-1",
              )}
            >
              {/* 详情数据未到时先用心跳数据兜底 */}
              <SandboxDetail
                data={detail ?? data}
                panelOpen={open}
                selectedFile={selected}
                onSelectFile={setSelected}
              />
            </ScrollArea>
            {/* 右：选中文件的预览（含文件名头 + 关闭） */}
            {selected && (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
                  <span className="truncate font-mono text-xs">{selected}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close preview"
                    onClick={() => setSelected(null)}
                  >
                    <X />
                  </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <FilePreview path={selected} />
                </ScrollArea>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

function SandboxDetail({
  data,
  panelOpen,
  selectedFile,
  onSelectFile,
}: {
  data: SandboxStatus | undefined;
  panelOpen: boolean;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const stopped = data?.exists && data.state === "stopped";
  // 删除倒计时锚点：停机时刻（updatedAt）+ autoDeleteMinutes
  const deleteAt =
    stopped && data?.updatedAt && data.autoDeleteMinutes != null && data.autoDeleteMinutes >= 0
      ? new Date(data.updatedAt).getTime() + data.autoDeleteMinutes * 60_000
      : null;
  const now = useNow(panelOpen && deleteAt !== null);

  if (!data) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!data.exists) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No sandbox yet. One is created automatically when you send a message that needs execution.
      </p>
    );
  }

  return (
    <div className="space-y-5 px-4 py-4">
      {/* 删除倒计时：停机态置顶强提示 */}
      {deleteAt !== null && (
        <div className="flex items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <Timer className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 text-sm">
            <span className="font-medium tabular-nums">
              {formatRemain(deleteAt - now)}
            </span>
            <span className="text-muted-foreground">
              {deleteAt - now > 0 ? " until auto-delete (workspace files will be reclaimed too)" : " (expired, will be reclaimed)"}
            </span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <InfoRow label="ID" value={<code className="font-mono text-xs">{data.id}</code>} />
        <InfoRow label="Created" value={formatTime(data.createdAt)} />
        <InfoRow label="Last state change" value={formatTime(data.updatedAt)} />
        {data.autoStopMinutes != null && data.autoStopMinutes > 0 && (
          <InfoRow label="Auto-stop" value={`After ${data.autoStopMinutes} min idle`} />
        )}
        {data.autoDeleteMinutes != null && data.autoDeleteMinutes >= 0 && (
          <InfoRow label="Auto-delete" value={`${data.autoDeleteMinutes} min after stop`} />
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Workspace files
        </h3>
        {data.state !== "started" ? (
          // 停机态不渲染文件树：列目录会 findUserSandbox 唤醒沙箱，仅查看不应续命
          <p className="text-sm text-muted-foreground">
            Sandbox is stopped; files will be visible on the next run.
          </p>
        ) : (
          <FileTree selected={selectedFile} onSelect={onSelectFile} />
        )}
      </div>
    </div>
  );
}
