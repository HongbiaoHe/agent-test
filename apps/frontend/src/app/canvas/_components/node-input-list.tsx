"use client";

import { Film, Image as ImageIcon, Type, Upload } from "lucide-react";

import type { CanvasNodeOutput, CanvasNodeType } from "@/lib/api";

import { useMediaAssetUrl } from "../_hooks/use-media-asset";
import type { NodeInputSource } from "../_lib/node-io";

/**
 * 图标按**来源节点类型**取，不按 output 类型——上游未就绪时 outputs 是空数组，
 * 从 outputs 取会一律退化成文本图标（上传节点显示成 T，与卡片上的类型对不上）。
 */
const NODE_ICON: Record<CanvasNodeType, React.ReactNode> = {
  text: <Type className="size-3.5" />,
  image_upload: <Upload className="size-3.5" />,
  image_gen: <ImageIcon className="size-3.5" />,
  video_gen: <Film className="size-3.5" />,
};

/** 未就绪 / 已就绪但不便直接展示的状态，统一用一枚淡色胶囊表示。 */
function StatusPill({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={
        "inline-flex rounded-full bg-muted px-1.5 py-0.5 text-[10px] " +
        (muted ? "text-muted-foreground/70" : "text-muted-foreground")
      }
    >
      {children}
    </span>
  );
}

/**
 * 「关联输入」区：沿入边列出上游节点及其当前输出。
 * 一行一路上游——左侧类型图标，右侧标题 + 内容预览；未就绪的标出来
 * （触发生成时它不会被引用，光看连线看不出这件事）。
 */
export function NodeInputList({ inputs }: { inputs: NodeInputSource[] }) {
  if (inputs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        Linked inputs · {inputs.length}
      </span>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border">
        {inputs.map((s) => (
          <li key={s.nodeId} className="flex gap-2.5 p-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {NODE_ICON[s.nodeType]}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-xs font-medium">{s.title}</p>
              {s.outputs.length === 0 ? (
                <StatusPill muted>Not ready yet</StatusPill>
              ) : (
                s.outputs.map((o, i) => (
                  <InputPreview key={i} output={o} sourceType={s.nodeType} />
                ))
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 单份输出的预览：文本给截断正文，生成图给缩略图，视频只给状态（不在面板里拉视频 blob）。 */
function InputPreview({
  output,
  sourceType,
}: {
  output: CanvasNodeOutput;
  /** 来源节点类型：决定 content 是 versionId 还是 assetPath（见 CanvasNodeOutput 注释） */
  sourceType: CanvasNodeType;
}) {
  // image_upload 是 MVP 模拟上传，content 存的是 assetPath，拉不到资产，只能显示路径
  const isAssetPath = sourceType === "image_upload";
  const url = useMediaAssetUrl(
    output.type === "image" && !isAssetPath ? output.content : null,
  );

  if (output.type === "text") {
    return (
      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        {output.content}
      </p>
    );
  }
  if (output.type === "video") {
    return <StatusPill>Video ready</StatusPill>;
  }
  if (isAssetPath) {
    return (
      <p className="truncate font-mono text-[10px] text-muted-foreground">
        {output.content}
      </p>
    );
  }
  // object-contain + 有界高度：参考图要看清全貌，object-cover 会把它裁成一条
  return url ? (
    // 用原生 img：blob 源 next/image 无法优化
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Linked input"
      className="max-h-40 w-full rounded border border-border bg-muted object-contain"
    />
  ) : (
    <div className="h-24 w-full animate-pulse rounded border border-border bg-muted" />
  );
}
