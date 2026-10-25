"use client";

import {
  AlertTriangle,
  Ban,
  Clock,
  Film,
  FlaskConical,
  ImageOff,
  Loader2,
  Music,
} from "lucide-react";
import { useContext, useEffect, useRef } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CanvasNodeOutput } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useMediaAsset } from "../_hooks/use-media-asset";
import type { ReferenceFate } from "../_lib/aigc-params";
import { isUploadNodeType, type NodeInputSource } from "../_lib/node-io";

import { CanvasEditorContext } from "./flow-canvas";
import { NodeTypeIcon } from "./node-meta";

/**
 * 生成节点面板顶上的附件栏：一路上游 = 一枚附件，排在提示词上面——
 * 写提示词时要对着素材写（"让 Image 1 里的人回头"），素材得先在眼前。
 *
 * 两种形态，按上游此刻有没有可看的资产分：
 * - 有资产（生成的或上传的图 / 视频 / 音频）：缩略图（音频是一枚图标）。会提交的角上标序号，
 *   按类型各自计数、= 入边顺序，提示词里按 `Image 1` / `Video 1` / `Audio 1` 引用的就是它；
 *   不会提交的（超出模型上限 / 首帧模式多出来的图）去色压淡，浮层里写明原因。指上去浮出大图；
 * - 还没产出：节点本身——与缩略图同尺寸的一格（「将来出图的位置」），中间放它此刻的状态
 *   （在跑 / 排队 / 失败 / 未生成 / 没传文件），标题与状态在指上去的浮层里。
 *   所有附件都是同一尺寸的正方形，排在一起读成同一排素材。
 *
 * 点任一枚都跳到那个上游节点；指上去（或 Tab 聚焦）时画布上那个节点先描一圈，
 * 点之前就知道要去哪。
 */
export function NodeAttachments({
  inputs,
  fates,
}: {
  inputs: NodeInputSource[];
  /** 与 inputs 一一对应：这一路这次会不会提交（见 planReferences） */
  fates: ReferenceFate[];
}) {
  if (inputs.length === 0) return null;

  return (
    // 折行而不是横向滚动：上游通常就一两路，全摆出来最直观；横滚会把后几枚藏在面板边缘外
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {inputs.map((source, i) => {
        // 有产物就能预览（content 都是版本 id）；每个节点至多一份输出
        const output = source.outputs[0];
        const fate = fates[i] ?? { used: false, reason: "pending" };
        return (
          <li key={source.nodeId} className="min-w-0">
            {output ? (
              <AssetTile source={source} output={output} fate={fate} />
            ) : (
              <NodeTile source={source} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 不提交的原因，写进浮层（只在去色的那几枚上出现） */
const SKIP_REASON: Record<
  Exclude<ReferenceFate, { used: true }>["reason"],
  string
> = {
  pending: "Not ready yet",
  type: "This node doesn't take this kind of input",
  frame: "This model starts from one frame — only the first image is used",
  limit: "Over this model's limit — not used",
};

/**
 * 指向某枚附件时，在画布上把对应节点描出来。直接切 DOM class、不走 state：
 * 这是一闪而过的指示，不值得让整张画布为它重渲染。卸载时收尾，免得描边残留。
 */
function usePeek(nodeId: string) {
  const elRef = useRef<Element | null>(null);

  useEffect(() => {
    const box = elRef;
    return () => box.current?.classList.remove(PEEK);
  }, []);

  const off = () => {
    elRef.current?.classList.remove(PEEK);
    elRef.current = null;
  };
  const on = () => {
    off();
    const el = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .canvas-node`,
    );
    el?.classList.add(PEEK);
    elRef.current = el;
  };
  return {
    handlers: {
      onPointerEnter: on,
      onPointerLeave: off,
      onFocus: on,
      onBlur: off,
    },
    off,
  };
}

const PEEK = "canvas-node--peek";

/** 附件的公共外观：同一高度、同一圆角；键盘聚焦给焦点环 */
const TILE =
  "group/tile relative flex h-12 cursor-pointer items-center overflow-hidden rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** 叠在缩略图 / 占位格上的细边：浅色图片贴着浅色面板时边缘会化开，靠它收住 */
const HAIRLINE =
  "pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-foreground/10 ring-inset transition-[box-shadow] duration-150";

/** 角标：序号 / 视频标记，同一套形态 */
const BADGE =
  "pointer-events-none absolute flex h-4 min-w-4 items-center justify-center rounded-[5px] bg-background/90 px-1 text-[10px] font-medium text-foreground tabular-nums ring-1 ring-foreground/10";

/** 资产在途：与卡片骨架同一种高光横扫 */
function Shimmer() {
  return (
    <span aria-hidden className="relative block size-full overflow-hidden">
      <span
        className="animate-media-shimmer absolute inset-0 -translate-x-full motion-reduce:hidden"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, var(--color-foreground), transparent)",
          opacity: 0.08,
        }}
      />
    </span>
  );
}

/** 已出资产的上游：缩略图 / 视频首帧 / 音频图标；指上去浮出大图 */
function AssetTile({
  source,
  output,
  fate,
}: {
  source: NodeInputSource;
  output: CanvasNodeOutput;
  fate: ReferenceFate;
}) {
  const { focusNode } = useContext(CanvasEditorContext);
  const peek = usePeek(source.nodeId);
  const audio = output.type === "audio";
  // 音频没有画面可缩略：不拉 blob，只摆一枚图标
  const asset = useMediaAsset(audio ? null : output.content);
  const video = output.type === "video";
  // 不会提交的照样展示，但去色压淡（原因写在浮层里）
  const unused = !fate.used;
  const name = fate.used ? fate.label : source.title;
  // 角标只写序号：类型由视频 / 音频标记区分，提示词里的叫法在浮层里给全
  const index = fate.used ? fate.label.split(" ")[1] : null;

  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={
          <button
            type="button"
            aria-label={`${name}${index ? `, ${source.title}` : ""}. Go to node`}
            onClick={() => {
              peek.off();
              focusNode(source.nodeId);
            }}
            {...peek.handlers}
            className={cn(TILE, "w-12 justify-center bg-muted")}
          />
        }
      >
        <span
          className={cn(
            "flex size-full items-center justify-center",
            unused && "opacity-60 saturate-0",
          )}
        >
          {audio ? (
            <Music className="size-4 text-muted-foreground" aria-hidden />
          ) : asset.status === "ready" ? (
            video ? (
              <video
                src={asset.url}
                muted
                playsInline
                preload="metadata"
                className="size-full object-cover"
              />
            ) : (
              // 用原生 img：blob 源 next/image 无法优化
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={asset.url}
                alt=""
                draggable={false}
                className="size-full object-cover transition-transform duration-200 ease-out group-hover/tile:scale-[1.04] motion-reduce:transition-none"
              />
            )
          ) : asset.status === "error" ? (
            <ImageOff className="size-4 text-muted-foreground" aria-hidden />
          ) : (
            <Shimmer />
          )}
        </span>
        <span
          aria-hidden
          className={cn(HAIRLINE, "group-hover/tile:ring-foreground/25")}
        />
        {index !== null && (
          <span aria-hidden className={cn(BADGE, "top-1 left-1")}>
            {index}
          </span>
        )}
        {source.mediaMock && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 flex size-4 items-center justify-center rounded-[5px] border border-warning/60 bg-background/90"
          >
            <FlaskConical className="size-2.5 text-warning" />
          </span>
        )}
        {(video || audio) && (
          <span aria-hidden className={cn(BADGE, "right-1 bottom-1 px-0.5")}>
            {video ? (
              <Film className="size-2.5" />
            ) : (
              <Music className="size-2.5" />
            )}
          </span>
        )}
      </TooltipTrigger>

      <TooltipContent
        variant="surface"
        side="top"
        className="w-56 flex-col items-stretch gap-0 p-1"
      >
        {asset.status === "ready" &&
          (video ? (
            <video
              src={asset.url}
              muted
              loop
              autoPlay
              playsInline
              className="max-h-40 w-full rounded-md bg-muted object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.url}
              alt=""
              className="max-h-40 w-full rounded-md bg-muted object-contain"
            />
          ))}
        <span className="block px-1.5 pt-1.5 pb-1">
          <span className="block truncate text-xs text-foreground">
            {fate.used ? (
              <>
                <span className="font-medium">{fate.label}</span>
                <span className="text-muted-foreground"> · {source.title}</span>
              </>
            ) : (
              <span className="font-medium">{source.title}</span>
            )}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {source.mediaMock && "Mock output · "}
            {!fate.used
              ? SKIP_REASON[fate.reason]
              : asset.status === "error"
                ? "Preview unavailable · click to open the node"
                : "Click to open the node"}
          </span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** 上游此刻的状态：图标 + 一句话。与画布卡片同一套语言（转圈 = 在跑，钟 = 排队） */
function nodeState(s: NodeInputSource): {
  icon: React.ReactNode;
  text: string;
  tone?: "danger";
  busy?: boolean;
} {
  // 没产物的上传节点：等用户传文件（有文件的走 AssetTile，到不了这里）
  if (isUploadNodeType(s.nodeType)) {
    return {
      icon: <NodeTypeIcon type={s.nodeType} />,
      text: "No file yet",
    };
  }
  switch (s.mediaStatus) {
    case "generating":
      return {
        icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />,
        text: s.nodeType === "video_concat" ? "Merging…" : "Generating…",
        busy: true,
      };
    case "queued":
      return {
        icon: <Clock className="size-3.5" aria-hidden />,
        text: "Queued",
        busy: true,
      };
    case "failed":
      return {
        icon: <AlertTriangle className="size-3.5" aria-hidden />,
        text: "Failed",
        tone: "danger",
      };
    case "cancelled":
      return {
        icon: <Ban className="size-3.5" aria-hidden />,
        text: "Cancelled",
      };
    default:
      return {
        icon: <NodeTypeIcon type={s.nodeType} />,
        text: "Not generated yet",
      };
  }
}

/** 还没产出资产的上游：与缩略图同尺寸的一格，中间是它此刻的状态；标题与状态在浮层里 */
function NodeTile({ source }: { source: NodeInputSource }) {
  const { focusNode } = useContext(CanvasEditorContext);
  const peek = usePeek(source.nodeId);
  const state = nodeState(source);
  const danger = state.tone === "danger";

  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={
          <button
            type="button"
            aria-label={`${source.title}, ${state.text}. Go to node`}
            onClick={() => {
              peek.off();
              focusNode(source.nodeId);
            }}
            {...peek.handlers}
            className={cn(
              TILE,
              "w-12 justify-center bg-muted transition-colors duration-150 hover:bg-accent",
              danger ? "text-destructive" : "text-muted-foreground",
            )}
          />
        }
      >
        {state.busy && (
          <span className="absolute inset-0">
            <Shimmer />
          </span>
        )}
        <span className="relative">{state.icon}</span>
        <span
          aria-hidden
          className={cn(HAIRLINE, "group-hover/tile:ring-foreground/25")}
        />
      </TooltipTrigger>
      <TooltipContent
        variant="surface"
        side="top"
        className="max-w-56 flex-col items-stretch gap-0 px-2.5 py-1.5"
      >
        <span className="block truncate text-xs font-medium text-foreground">
          {source.title}
        </span>
        <span
          className={cn(
            "block text-[11px]",
            danger ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {state.text} · click to open the node
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
