"use client";

import { CircleSlash, Timer, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ThreadItem } from "../lib/thread";
import {
  formatClockSeconds,
  formatDuration,
  formatFullDateTime,
  isSameDay,
} from "../lib/time";

type TurnItem = Extract<ThreadItem, { kind: "turn" }>;

const ICON = { done: Timer, stopped: CircleSlash, failed: TriangleAlert };

/** 一轮结束的总耗时（常显），hover 看开始 / 结束的完整时刻。 */
export function TurnFooter({ item }: { item: TurnItem }) {
  const { t } = useTranslation();
  const Icon = ICON[item.status];
  const duration = formatDuration(item.endedAt - item.startedAt);
  const end = isSameDay(item.startedAt, item.endedAt)
    ? formatClockSeconds(item.endedAt)
    : formatFullDateTime(item.endedAt);
  return (
    <div className="flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground" />
          }
        >
          <Icon className="size-3.5" />
          <span className="tabular-nums">
            {item.status === "stopped"
              ? t("chat.turn.stoppedAfter", { duration })
              : item.status === "failed"
                ? t("chat.turn.failedAfter", { duration })
                : duration}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
          <span className="flex flex-col gap-0.5 text-left tabular-nums">
            <span>{t("chat.turn.started", { time: formatFullDateTime(item.startedAt) })}</span>
            <span>{t("chat.turn.finished", { time: end })}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
