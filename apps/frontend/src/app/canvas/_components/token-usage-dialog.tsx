"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Coins, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  getCanvasTokenUsage,
  type CanvasTokenCall,
  type CanvasTokenModelUsage,
  type CanvasTokenRun,
  type CanvasTokenTotals,
} from "@/lib/api";
import { canvasModelLabel } from "../_lib/models";

/**
 * token 消耗详情弹窗：会话总结 + 按模型 + 每轮（可展开到每次模型调用）。
 *
 * 口径：cacheRead ⊆ input（provider 回的 input_tokens 已含缓存部分），
 * 所以缓存命中率 = cacheRead / input，分母不能用 total。
 * 「思考」= total − input − output：Gemini 把思考量只记进 total，单列出来才能让
 * 「输入 + 输出 + 思考 = 合计」成立；DeepSeek 把它算进 output，这一项恒为 0。
 * 数据随 token_usage 事件失效重拉（见 use-canvas），运行期打开也是最新的。
 */
export function TokenUsageDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["canvas-token-usage", sessionId],
    queryFn: () => getCanvasTokenUsage(sessionId),
    enabled: open,
    staleTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Coins className="size-4" />
            Token 消耗详情
          </DialogTitle>
          <DialogDescription className="text-xs">
            缓存命中率 = 命中缓存的输入 token ÷ 输入 token（provider
            回的输入量已包含缓存部分）。缓存数据自本功能上线起记录，更早的运行按 0 计。
          </DialogDescription>
        </DialogHeader>

        {/* 原生滚动而非 ScrollArea：弹窗高度来自 max-h（对百分比而言不确定），
            ScrollArea 的 viewport 用 h-full 会退化成内容高度而不裁剪，内容直接溢出弹窗。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-4">
            {isPending ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在统计…
              </div>
            ) : isError ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center text-sm">
                <p className="text-destructive">
                  {error instanceof Error ? error.message : "读取用量失败"}
                </p>
                <Button size="sm" variant="outline" onClick={() => void refetch()}>
                  <RotateCw />
                  重试
                </Button>
              </div>
            ) : data.totals.calls === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                这个画布还没有模型调用记录。
              </p>
            ) : (
              <>
                <SummaryCard totals={data.totals} refreshing={isFetching} />

                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    按模型（{data.byModel.length}）
                  </h3>
                  <div className="flex flex-col gap-2">
                    {data.byModel.map((m) => (
                      <ModelRow key={m.model} usage={m} />
                    ))}
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    每轮运行（{data.runs.length}）
                  </h3>
                  <div className="flex flex-col gap-2">
                    {data.runs.map((run) => (
                      <RunRow key={run.runId} run={run} />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 会话总结：总量 + 输入/输出/思考拆分 + 缓存命中率条。 */
function SummaryCard({
  totals,
  refreshing,
}: {
  totals: CanvasTokenTotals;
  refreshing: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-medium tabular-nums">
          {totals.total.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">tokens 合计</span>
        {refreshing && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>
      {/*
        「思考」= total − input − output：Gemini 只把思考量记进 total，不列出来的话
        「输入 + 输出」加起来对不上上面的合计。DeepSeek 把它算进 output，这一项为 0。
      */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="输入" value={totals.input} />
        <Stat label="输出" value={totals.output} />
        <Stat label="思考" value={totals.reasoning} />
        <Stat label="命中缓存" value={totals.cacheRead} />
        <Stat label="模型调用" value={totals.calls} suffix="次" />
      </div>
      <Separator className="my-3" />
      <CacheRate totals={totals} />
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm tabular-nums">
        {value.toLocaleString()}
        {suffix ? ` ${suffix}` : ""}
      </span>
    </div>
  );
}

/** 缓存命中率：文字 + 细进度条。input 为 0 时不算（显示 —）。 */
function CacheRate({
  totals,
  compact,
}: {
  totals: CanvasTokenTotals;
  compact?: boolean;
}) {
  const rate = totals.input > 0 ? totals.cacheRead / totals.input : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">缓存命中率</span>
        <span className="tabular-nums">
          {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
          {!compact && (
            <span className="ml-1.5 text-muted-foreground">
              {totals.cacheRead.toLocaleString()} / {totals.input.toLocaleString()}
              {totals.cacheCreation > 0 &&
                ` · 写入缓存 ${totals.cacheCreation.toLocaleString()}`}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${(rate ?? 0) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** 按模型一行：模型名 + 调用次数 + 输入/输出/合计 + 命中率条。 */
function ModelRow({ usage }: { usage: CanvasTokenModelUsage }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {canvasModelLabel(usage.model)}
        </span>
        <Badge variant="secondary" className="shrink-0 tabular-nums">
          {usage.total.toLocaleString()}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        <span>输入 {usage.input.toLocaleString()}</span>
        <span>输出 {usage.output.toLocaleString()}</span>
        {usage.reasoning > 0 && (
          <span>思考 {usage.reasoning.toLocaleString()}</span>
        )}
        <span>{usage.calls} 次调用</span>
      </div>
      <div className="mt-2">
        <CacheRate totals={usage} compact />
      </div>
    </div>
  );
}

/** 每轮一行：可展开看该轮的按模型合计与每次调用明细。 */
function RunRow({ run }: { run: CanvasTokenRun }) {
  const [expanded, setExpanded] = useState(false);
  const rate =
    run.totals.input > 0 ? run.totals.cacheRead / run.totals.input : null;

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/60"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">
              {run.goal || "（续跑，无新目标）"}
            </span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {run.status}
            </Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
            <span>{formatTime(run.startedAt)}</span>
            <span>输入 {run.totals.input.toLocaleString()}</span>
            <span>输出 {run.totals.output.toLocaleString()}</span>
            {run.totals.reasoning > 0 && (
              <span>思考 {run.totals.reasoning.toLocaleString()}</span>
            )}
            <span>{run.totals.calls} 次调用</span>
            <span>命中 {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}</span>
          </div>
        </div>
        <span className="shrink-0 text-sm tabular-nums">
          {run.totals.total.toLocaleString()}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-3">
          {run.totals.calls === 0 ? (
            <p className="text-xs text-muted-foreground">这一轮没有模型调用记录。</p>
          ) : (
            <>
              {run.byModel.length > 1 && (
                <div className="mb-3 flex flex-col gap-1 text-xs text-muted-foreground">
                  {run.byModel.map((m) => (
                    <div key={m.model} className="flex justify-between gap-2">
                      <span className="truncate">{canvasModelLabel(m.model)}</span>
                      <span className="tabular-nums">
                        {m.total.toLocaleString()}（{m.calls} 次）
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <CallTable calls={run.calls} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 每次模型调用明细表。 */
function CallTable({ calls }: { calls: CanvasTokenCall[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3 text-left font-medium">时间</th>
            <th className="py-1.5 pr-3 text-left font-medium">模型</th>
            <th className="py-1.5 pr-3 text-right font-medium">输入</th>
            <th className="py-1.5 pr-3 text-right font-medium">命中缓存</th>
            <th className="py-1.5 pr-3 text-right font-medium">输出</th>
            <th className="py-1.5 text-right font-medium">合计</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">
                {formatTime(c.at)}
              </td>
              <td className="max-w-[9rem] truncate py-1.5 pr-3">
                {canvasModelLabel(c.model)}
              </td>
              <td className="py-1.5 pr-3 text-right">{c.input.toLocaleString()}</td>
              <td className="py-1.5 pr-3 text-right">
                {c.cacheRead > 0 ? (
                  c.cacheRead.toLocaleString()
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right">{c.output.toLocaleString()}</td>
              <td className="py-1.5 text-right">{c.total.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
