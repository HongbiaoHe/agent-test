"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Server, Timer } from "lucide-react";
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

/** 沙箱状态 → 展示语义（点的颜色 / 徽标文案）。 */
function toneOf(data: SandboxStatus | undefined) {
  if (!data?.exists) return { dot: "bg-muted-foreground/40", label: "No sandbox", variant: "outline" as const };
  if (data.state === "started")
    return { dot: "bg-success", label: "Running", variant: "secondary" as const };
  if (data.state === "stopped")
    return { dot: "bg-warning", label: "Stopped", variant: "outline" as const };
  return { dot: "bg-warning", label: data.state ?? "Unknown", variant: "outline" as const };
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
  const { data: detail } = useQuery({
    queryKey: ["sandbox-status", "files"],
    queryFn: () => fetchSandboxStatus(true),
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  const tone = toneOf(data);
  const running = data?.exists && data.state === "started";

  function openPanel() {
    // enabled:open 翻转后 React Query 立即发起详情查询，无需手动 refetch
    setOpen(true);
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

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2">
              <Server className="size-4" />
              Sandbox
              <Badge variant={tone.variant}>{tone.label}</Badge>
            </SheetTitle>
            <SheetDescription>
              Each user gets a dedicated sandbox; all conversations share the same workspace.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            {/* 详情数据未到时先用心跳数据兜底（除 files 外字段一致） */}
            <SandboxDetail data={detail ?? data} panelOpen={open} />
          </ScrollArea>
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
}: {
  data: SandboxStatus | undefined;
  panelOpen: boolean;
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
          <p className="text-sm text-muted-foreground">
            Sandbox is stopped; files will be visible on the next run.
          </p>
        ) : !data.files ? (
          // files=null：详情查询（?files=1）还没返回，心跳数据不含文件
          <p className="text-sm text-muted-foreground">Loading files…</p>
        ) : data.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No output files in the workspace yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.files.map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{f.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
