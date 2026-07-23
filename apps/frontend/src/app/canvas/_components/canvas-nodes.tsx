"use client";

import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { Image as ImageIcon, Film, Type, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchMediaAssetBlob, type CanvasNodeDto } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

/** react-flow 节点 data 即后端 CanvasNodeDto。 */
type NodeData = CanvasNodeDto & Record<string, unknown>;

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  generating: "生成中",
  done: "已完成",
  failed: "失败",
};

function NodeShell({
  icon,
  title,
  tone,
  children,
  hasTarget,
  hasSource,
}: {
  icon: React.ReactNode;
  title: string;
  /** 类型身份色 CSS 变量，如 "var(--node-text)"；下游强调件统一从 --tone 取色（见 globals.css .canvas-node）。 */
  tone: string;
  children: React.ReactNode;
  hasTarget?: boolean;
  hasSource?: boolean;
}) {
  return (
    <div
      className="canvas-node w-56 rounded-lg border border-border bg-card text-card-foreground shadow-sm"
      // 内联设置 CSS 自定义属性 --tone；CSSProperties 不含自定义属性键，故就近断言（安全：仅注入颜色变量）
      style={{ "--tone": tone } as React.CSSProperties}
    >
      <span className="canvas-node__rail" aria-hidden />
      {hasTarget && <Handle type="target" position={Position.Left} />}
      <div className="canvas-node__header flex items-center gap-2 rounded-t-lg border-b px-3 py-2 text-sm font-medium text-foreground">
        <span className="canvas-node__icon">{icon}</span>
        <span className="truncate">{title}</span>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground">{children}</div>
      {hasSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

/** 生成节点资产预览：generationId JOIN 出的 versionId 就绪后拉带鉴权 blob。 */
function MediaPreview({ versionId, kind }: { versionId: string; kind: "image" | "video" }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let alive = true;
    void fetchMediaAssetBlob(versionId)
      .then((blob) => {
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        revoked = u;
        setUrl(u);
      })
      .catch(() => void 0);
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [versionId]);
  if (!url) return <div className="h-24 animate-pulse rounded bg-muted" />;
  return kind === "image" ? (
    // 用原生 img：blob 源 next/image 无法优化
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="生成结果" className="max-h-40 w-full rounded object-cover" />
  ) : (
    <video src={url} controls className="max-h-40 w-full rounded" />
  );
}

function MediaBody({ data, kind }: { data: NodeData; kind: "image" | "video" }) {
  return (
    <div className="space-y-2">
      <p className="line-clamp-3">{data.prompt || "（未填提示词）"}</p>
      {data.mediaStatus && (
        <Badge variant={data.mediaStatus === "failed" ? "destructive" : "secondary"}>
          {STATUS_LABEL[data.mediaStatus] ?? data.mediaStatus}
        </Badge>
      )}
      {data.mediaStatus === "done" && data.mediaVersionId && (
        <MediaPreview versionId={data.mediaVersionId} kind={kind} />
      )}
    </div>
  );
}

function TextNode({ data }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<Type className="size-4" />}
      title={d.label || "文本"}
      tone="var(--node-text)"
      hasSource
    >
      <p className="line-clamp-4 whitespace-pre-wrap">{d.text || "（空）"}</p>
    </NodeShell>
  );
}

function ImageUploadNode({ data }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      icon={<Upload className="size-4" />}
      title={d.label || "上传图片"}
      tone="var(--node-upload)"
      hasSource
    >
      <p>{d.assetPath ? "已上传（模拟）" : "未上传"}</p>
    </NodeShell>
  );
}

function ImageGenNode({ data }: NodeProps) {
  return (
    <NodeShell
      icon={<ImageIcon className="size-4" />}
      title={(data as NodeData).label || "生图"}
      tone="var(--node-image)"
      hasTarget
      hasSource
    >
      <MediaBody data={data as NodeData} kind="image" />
    </NodeShell>
  );
}

function VideoGenNode({ data }: NodeProps) {
  return (
    <NodeShell
      icon={<Film className="size-4" />}
      title={(data as NodeData).label || "生视频"}
      tone="var(--node-video)"
      hasTarget
      hasSource
    >
      <MediaBody data={data as NodeData} kind="video" />
    </NodeShell>
  );
}

export const nodeTypes: NodeTypes = {
  text: TextNode,
  image_upload: ImageUploadNode,
  image_gen: ImageGenNode,
  video_gen: VideoGenNode,
};
