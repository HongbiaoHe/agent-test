"use client";

import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import {
  AlertCircle,
  Clock,
  Image as ImageIcon,
  Film,
  Link2,
  Loader2,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { useContext } from "react";

import type { CanvasNodeDto } from "@/lib/api";

import { useMediaAssetUrl } from "../_hooks/use-media-asset";
import { resolvePrompt, type NodeInputSource } from "../_lib/node-io";
import { CanvasEditorContext } from "./flow-canvas";
import { NodeEditorToolbar, type NodeBodyField } from "./node-editor-toolbar";

/** react-flow 节点 data 即后端 CanvasNodeDto。 */
type NodeData = CanvasNodeDto & Record<string, unknown>;

/**
 * 节点外壳：纯展示（内容编辑走选中后浮出的 NodeEditorToolbar）。
 *
 * 「内容优先」形态，两种排布共用一套壳（视觉见 globals.css .canvas-node）：
 * - 媒体型（传 cover）：预览满宽置顶 + 类型 chip 浮在预览左上角，标题与正文退到下方；
 * - 文本型（不传 cover）：类型与标题降为 11px caption，正文升为卡片主体。
 */
function NodeShell({
  icon,
  nodeId,
  selected,
  dragging,
  label,
  fallbackTitle,
  tone,
  body,
  cover,
  busy,
  children,
  hasTarget,
  hasSource,
}: {
  icon: React.ReactNode;
  nodeId: string;
  /** react-flow 选中态：决定编辑浮窗是否浮出 */
  selected: boolean;
  /** 正在拖拽：拖动期间隐藏浮窗 */
  dragging: boolean;
  label: string;
  /** label 为空时的类型缺省标题（文本/生图/生视频/上传图片），同时是封面 chip 的文字 */
  fallbackTitle: string;
  /** 类型身份色 CSS 变量，如 "var(--node-text)"；卡面全中性，仅连接点取此色（见 globals.css .canvas-node）。 */
  tone: string;
  /** 浮窗里除 label 外的正文字段（image_upload 无正文可编辑，故可选） */
  body?: NodeBodyField;
  /** 满宽封面（媒体型节点传入；不传即文本型排布） */
  cover?: React.ReactNode;
  /** 生成中：整卡加一圈旋转高光环 */
  busy?: boolean;
  children: React.ReactNode;
  hasTarget?: boolean;
  hasSource?: boolean;
}) {
  return (
    <div
      className="canvas-node group/node w-64 rounded-lg border border-border bg-card text-card-foreground shadow-sm"
      // 内联设置 CSS 自定义属性 --tone；CSSProperties 不含自定义属性键，故就近断言（安全：仅注入颜色变量）
      style={{ "--tone": tone } as React.CSSProperties}
    >
      <DeleteNodeButton nodeId={nodeId} />
      {/* 选中时浮出的编辑面板（运行期不显示，见 NodeEditorToolbar） */}
      <NodeEditorToolbar
        nodeId={nodeId}
        selected={selected}
        dragging={dragging}
        label={label}
        labelPlaceholder={fallbackTitle}
        body={body}
      />
      {busy && <span className="canvas-node__glow" aria-hidden />}
      {hasTarget && <Handle type="target" position={Position.Left} />}
      {cover ? (
        <>
          <div className="canvas-node__cover">
            {cover}
            <span className="canvas-node__chip">
              {icon}
              {fallbackTitle}
            </span>
          </div>
          <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
            <span className="truncate text-[13px] font-medium">
              {label || fallbackTitle}
            </span>
            <div className="text-xs leading-relaxed text-muted-foreground">
              {children}
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {icon}
            <span className="min-w-0 flex-1 truncate">
              {label || fallbackTitle}
            </span>
          </span>
          <div className="text-[13px] leading-relaxed">{children}</div>
        </div>
      )}
      {hasSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

/**
 * 节点右上角的删除按钮：桌面 hover 才出现（常显会让画布很吵），触屏常显（没有 hover 可用）。
 * 显隐纯 CSS，不用 JS 判断断点——避免水合首帧的显隐跳变。
 * 运行期（readOnly）不渲染，与其它结构编辑一致。
 */
function DeleteNodeButton({ nodeId }: { nodeId: string }) {
  const { readOnly, deleteNode } = useContext(CanvasEditorContext);
  if (readOnly) return null;
  return (
    <button
      type="button"
      // nodrag：按在按钮上不拖动节点；stopPropagation：不连带选中节点
      className="nodrag absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-md border border-border bg-card/85 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/node:opacity-100 [@media(pointer:coarse)]:opacity-100"
      title="Delete node"
      aria-label="Delete node"
      onClick={(e) => {
        e.stopPropagation();
        deleteNode(nodeId);
      }}
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

/**
 * 封面占位：整块 muted 区域承载状态文案（未生成 / 排队中 / 生成中 / 失败 / 拉取预览中）。
 * 生成中额外叠一层满幅高光横扫（.canvas-node__shimmer），配合整卡高光环放大「在跑」的可见度。
 */
function CoverPlaceholder({
  icon,
  text,
  shimmer,
  failed,
}: {
  icon: React.ReactNode;
  text: string;
  shimmer?: boolean;
  failed?: boolean;
}) {
  return (
    <div
      className={
        "flex h-32 flex-col items-center justify-center gap-1.5 " +
        (failed ? "text-destructive" : "text-muted-foreground")
      }
    >
      {shimmer && <span className="canvas-node__shimmer" aria-hidden />}
      {icon}
      <span className="text-[11px]">{text}</span>
    </div>
  );
}

/** 生成节点资产预览：generationId JOIN 出的 versionId 就绪后拉带鉴权 blob，满宽铺在封面区。 */
function MediaPreview({
  versionId,
  kind,
}: {
  versionId: string;
  kind: "image" | "video";
}) {
  const url = useMediaAssetUrl(versionId);
  if (!url) {
    return (
      <CoverPlaceholder
        icon={<Loader2 className="size-5 animate-spin" />}
        text="Loading preview…"
        shimmer
      />
    );
  }
  return kind === "image" ? (
    // 用原生 img：blob 源 next/image 无法优化
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="Generated result" className="block h-32 w-full object-cover" />
  ) : (
    <video src={url} controls className="block h-32 w-full object-cover" />
  );
}

/**
 * 生成节点卡片正文：显示本次生成会用的提示词——它来自上游 text 节点，节点自身不存 prompt。
 * 没有上游文本就直接说清楚该怎么办（此时触发生成后端也会报错）。
 */
function UpstreamPrompt({ nodeId }: { nodeId: string }) {
  const { resolveInputs } = useContext(CanvasEditorContext);
  const inputs = resolveInputs(nodeId);
  const prompt = resolvePrompt(inputs);
  return (
    <>
      {prompt ? (
        <p className="line-clamp-4 whitespace-pre-wrap">{prompt}</p>
      ) : (
        <p className="italic">Connect a text node for the prompt</p>
      )}
      <InputSummary inputs={inputs} />
    </>
  );
}

/**
 * 卡片底部的关联输入摘要：这个节点由哪几路上游喂进来。
 * 按 output 类型计数；上游还没就绪的（正文为空 / 尚未生成）单独记为 pending，
 * 因为触发生成时它们不会被引用——这一点光看连线是看不出来的。
 */
function InputSummary({ inputs }: { inputs: NodeInputSource[] }) {
  if (inputs.length === 0) return null;

  const counts = new Map<string, number>();
  let pending = 0;
  for (const s of inputs) {
    if (s.outputs.length === 0) {
      pending++;
      continue;
    }
    for (const o of s.outputs) {
      counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    }
  }

  const parts = [...counts].map(([type, n]) => `${n} ${type}`);
  if (pending > 0) parts.push(`${pending} pending`);

  return (
    <span className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
      <Link2 className="size-3 shrink-0" />
      <span className="truncate">{parts.join(" · ")}</span>
    </span>
  );
}

/** 生成节点封面：done 且资产就绪→放预览，否则按 mediaStatus 出对应占位。 */
function MediaCover({
  data,
  kind,
  typeIcon,
}: {
  data: NodeData;
  kind: "image" | "video";
  typeIcon: React.ReactNode;
}) {
  if (data.mediaStatus === "done" && data.mediaVersionId) {
    return <MediaPreview versionId={data.mediaVersionId} kind={kind} />;
  }
  switch (data.mediaStatus) {
    case "generating":
      return (
        <CoverPlaceholder
          icon={<Loader2 className="size-5 animate-spin" />}
          text="Generating…"
          shimmer
        />
      );
    case "queued":
      return <CoverPlaceholder icon={<Clock className="size-5" />} text="Queued" />;
    case "failed":
      return (
        <CoverPlaceholder
          icon={<AlertCircle className="size-5" />}
          text="Generation failed"
          failed
        />
      );
    // done 但资产还没 JOIN 出来，与「从未生成」一样只能出类型占位
    default:
      return <CoverPlaceholder icon={typeIcon} text="Not generated" />;
  }
}

function TextNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<Type className="size-3.5 shrink-0" />}
      nodeId={d.id}
      selected={!!selected}
      dragging={!!dragging}
      label={d.label ?? ""}
      fallbackTitle="Text"
      tone="var(--node-text)"
      body={{
        field: "text",
        value: d.text ?? "",
        placeholder: "Node text…",
      }}
      hasSource
    >
      <p className="line-clamp-4 whitespace-pre-wrap">
        {d.text || <span className="text-muted-foreground">(empty)</span>}
      </p>
    </NodeShell>
  );
}

function ImageUploadNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<Upload className="size-3 shrink-0" />}
      nodeId={d.id}
      selected={!!selected}
      dragging={!!dragging}
      label={d.label ?? ""}
      fallbackTitle="Upload"
      tone="var(--node-upload)"
      cover={
        <CoverPlaceholder
          icon={<Upload className="size-5" />}
          text={d.assetPath ? "Uploaded (mock)" : "No image"}
        />
      }
      hasSource
    >
      <p className="truncate">{d.assetPath ?? "Drop or pick an image"}</p>
    </NodeShell>
  );
}

function ImageGenNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<ImageIcon className="size-3 shrink-0" />}
      nodeId={d.id}
      selected={!!selected}
      dragging={!!dragging}
      label={d.label ?? ""}
      fallbackTitle="Image"
      tone="var(--node-image)"
      cover={
        <MediaCover
          data={d}
          kind="image"
          typeIcon={<ImageIcon className="size-5" />}
        />
      }
      busy={d.mediaStatus === "generating"}
      hasTarget
      hasSource
    >
      <UpstreamPrompt nodeId={d.id} />
    </NodeShell>
  );
}

function VideoGenNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<Film className="size-3 shrink-0" />}
      nodeId={d.id}
      selected={!!selected}
      dragging={!!dragging}
      label={d.label ?? ""}
      fallbackTitle="Video"
      tone="var(--node-video)"
      cover={
        <MediaCover data={d} kind="video" typeIcon={<Film className="size-5" />} />
      }
      busy={d.mediaStatus === "generating"}
      hasTarget
      hasSource
    >
      <UpstreamPrompt nodeId={d.id} />
    </NodeShell>
  );
}

export const nodeTypes: NodeTypes = {
  text: TextNode,
  image_upload: ImageUploadNode,
  image_gen: ImageGenNode,
  video_gen: VideoGenNode,
};
