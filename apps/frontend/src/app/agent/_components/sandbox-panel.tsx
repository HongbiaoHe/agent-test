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
  if (!data?.exists) return { dot: "bg-muted-foreground/40", label: "无沙箱", variant: "outline" as const };
  if (data.state === "started")
    return { dot: "bg-success", label: "运行中", variant: "secondary" as const };
  if (data.state === "stopped")
    return { dot: "bg-warning", label: "已停机", variant: "outline" as const };
  return { dot: "bg-warning", label: data.state ?? "未知", variant: "outline" as const };
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
  if (ms <= 0) return "随时回收";
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
              aria-label="沙箱状态"
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
        <TooltipContent>沙箱：{tone.label}</TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2">
              <Server className="size-4" />
              沙箱
              <Badge variant={tone.variant}>{tone.label}</Badge>
            </SheetTitle>
            <SheetDescription>
              每个用户一个专属沙箱，所有会话共享同一工作区。
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
    return <p className="px-4 py-6 text-sm text-muted-foreground">加载中…</p>;
  }
  if (!data.exists) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        暂无沙箱。发送需要执行能力的消息后会自动创建。
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
              {deleteAt - now > 0 ? " 后自动删除（工作区文件将一并回收）" : "（已到期，将被回收）"}
            </span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <InfoRow label="ID" value={<code className="font-mono text-xs">{data.id}</code>} />
        <InfoRow label="创建时间" value={formatTime(data.createdAt)} />
        <InfoRow label="最近状态变更" value={formatTime(data.updatedAt)} />
        {data.autoStopMinutes != null && data.autoStopMinutes > 0 && (
          <InfoRow label="自动停机" value={`闲置 ${data.autoStopMinutes} 分钟后`} />
        )}
        {data.autoDeleteMinutes != null && data.autoDeleteMinutes >= 0 && (
          <InfoRow label="自动删除" value={`停机 ${data.autoDeleteMinutes} 分钟后`} />
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          工作区文件
        </h3>
        {data.state !== "started" ? (
          <p className="text-sm text-muted-foreground">
            沙箱停机中，文件在下次运行时可见。
          </p>
        ) : !data.files ? (
          // files=null：详情查询（?files=1）还没返回，心跳数据不含文件
          <p className="text-sm text-muted-foreground">文件加载中…</p>
        ) : data.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">工作区暂无产物文件。</p>
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
