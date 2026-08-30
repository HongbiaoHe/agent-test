"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";

import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { renameCanvas } from "@/lib/api";

import type { SaveState } from "../_hooks/use-canvas";
import {
  CanvasIsland,
  CanvasIslandButton,
  CanvasIslandDivider,
} from "./canvas-island";
import { CanvasSaveStatus } from "./canvas-save-status";

/**
 * 桌面端悬浮面板顶部要让出的高度：上边距 12 + 岛高 46 + 与面板的间距 12。
 * 岛高 46 = 按钮 36（size-9）+ 容器 padding 8（p-1 上下）+ 边框 2。
 * ⚠️ 改岛的 `top-3`、按钮尺寸或 CanvasIsland 的 padding 时必须同步改这里，
 * 否则面板会压到岛上（或与岛之间空出多余的缝）。
 */
export const CANVAS_HEADER_INSET = 70;

const emptySubscribe = () => () => {};

/**
 * 亮/暗切换（画布版）。逻辑与 `app/_components/theme-toggle` 同源，但那个是 shadcn
 * Button 的 icon-sm 尺寸，塞进浮岛会比其它悬浮键矮一圈；这里只借它的 mounted 守卫写法，
 * 外观走 CanvasIslandButton 以对齐画布上的其它按钮。
 *
 * mounted 守卫用 useSyncExternalStore：SSR 与首个客户端渲染都返回 false，渲染与服务端
 * 一致的占位图标，避免读不到 resolvedTheme 造成水合不一致（也规避 set-state-in-effect）。
 */
function CanvasThemeButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <CanvasIslandButton
      icon={isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      label={isDark ? "切换到浅色" : "切换到暗色"}
      tooltipSide="left"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    />
  );
}

/** 画布标题：点一下就地改名。提交后乐观显示新名，等快照回来再交还给服务端值。 */
function CanvasTitle({
  sessionId,
  title,
}: {
  sessionId: string;
  title: string | null;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 提交后到快照刷新回来之前，先显示用户刚输入的名字，避免闪回旧值
  const [pending, setPending] = useState<string | null>(null);
  // Esc/Enter 与随后的 blur 会连着触发两次，用它保证只结算一次
  const finishRef = useRef(false);

  const shown = pending ?? title ?? "Untitled canvas";
  // 服务端值追上来了就交还控制权（render 期同步 state，规避 Next16 的 effect-setState 限制）
  if (pending !== null && title === pending) setPending(null);

  const rename = useMutation({
    mutationFn: (next: string) => renameCanvas(sessionId, next),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["canvas", sessionId] });
      void qc.invalidateQueries({ queryKey: ["canvas-list"] });
    },
  });

  function start() {
    finishRef.current = false;
    setDraft(title ?? "");
    setEditing(true);
  }
  function commit() {
    if (finishRef.current) return;
    finishRef.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title) {
      setPending(next);
      rename.mutate(next);
    }
  }
  function cancel() {
    if (finishRef.current) return;
    finishRef.current = true;
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        aria-label="Canvas name"
        className="h-7 w-44 px-2 py-0 text-sm max-md:w-28"
      />
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={start}
            title={shown}
            className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent motion-reduce:transition-none"
          />
        }
      >
        {shown}
      </TooltipTrigger>
      <TooltipContent side="bottom">Click to rename</TooltipContent>
    </Tooltip>
  );
}

/** agent 运行中的状态胶囊：一颗脉动点 + 一句话 + 只读锁，不用转圈。 */
function AgentRunningBadge() {
  return (
    <div className="canvas-badge-pop pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-card/85 pl-2.5 pr-3 text-xs shadow-lg backdrop-blur-md">
      {/* 与侧栏画布列表的运行态圆点同一套语言（见 canvas-sidebar 的 STATUS_DOT） */}
      <span
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
        aria-hidden
      />
      <span className="font-medium text-foreground" role="status">
        {/* 小屏换更短的说法，横向放得下左右两座岛 */}
        <span className="max-md:hidden">Agent working</span>
        <span className="md:hidden">Running</span>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} className="flex shrink-0 items-center" />}
        >
          <Lock className="size-3 text-muted-foreground" strokeWidth={2.5} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Canvas is read-only while the agent runs
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * 画布顶部的悬浮控件：左边「返回 + 画布名」，紧挨着是保存状态，中间是运行状态，右边主题切换。
 *
 * 刻意不做成横跨画布的一条 header——那会把画布从视觉上切开，也和底部缩放条、右侧面板入口
 * 那种「内容撑开的小岛」不是一套语言。保存状态与运行状态都不是常驻信息，各自是会自己来去的
 * 独立胶囊，不占据常驻岛里的位置。
 *
 * 手机上同样展示，只是标题更窄、运行状态换短文案、保存状态收成纯图标。
 * 桌面面板的可摆放区域由 `CANVAS_HEADER_INSET` 从顶部让开。
 */
export function CanvasHeader({
  sessionId,
  title,
  saveStates,
  busy,
}: {
  sessionId: string;
  /** 画布标题；快照未落地时为 null，先占位免得岛塌成一个光秃秃的圆 */
  title: string | null;
  saveStates: Record<string, SaveState>;
  /** agent 运行中：中间浮出运行状态胶囊 */
  busy: boolean;
}) {
  const router = useRouter();

  return (
    // 透明的布局条，只负责排布——视觉上仍是彼此分离的几座岛，画布并没有被一条 header 切开。
    // 用 flex 而不是各自绝对定位：左右两组 flex-1 等分剩余空间，中间那枚就落在正中，
    // 且 flex 天然不重叠——绝对居中的写法感知不到两侧宽度，小屏上会和左岛压在一起。
    <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-center gap-2">
      {/* 左：常驻的岛 + 会自己来去的保存状态，后者跟在岛右边而不是塞进去。
          min-w-0 让空间不够时标题先截断，而不是把中间那枚挤走 */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <CanvasIsland className="min-w-0 pr-2">
          <CanvasIslandButton
            icon={<ArrowLeft className="size-4" />}
            label="Back to canvases"
            onClick={() => router.push("/canvas")}
          />
          <CanvasIslandDivider />
          <CanvasTitle sessionId={sessionId} title={title} />
        </CanvasIsland>
        <CanvasSaveStatus
          saveStates={saveStates}
          className="canvas-badge-pop h-8 shrink-0 rounded-full border border-border bg-card/85 px-2.5 shadow-lg backdrop-blur-md"
        />
      </div>

      <div className="shrink-0">{busy && <AgentRunningBadge />}</div>

      <div className="flex min-w-0 flex-1 justify-end">
        <CanvasIsland>
          <CanvasThemeButton />
        </CanvasIsland>
      </div>
    </div>
  );
}
