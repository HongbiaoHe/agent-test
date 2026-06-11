"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchMediaAssetBlob,
  listConversationMedia,
  type MediaGeneration,
  type MediaStatus,
  type MediaVersion,
  regenerateMedia,
} from "@/lib/api";

/** 类型 → 图标 / 文案 / 工具名。卡片头部、生成中占位与失败态共用。 */
const TYPE_META = {
  image: { Icon: ImageIcon, label: "Image", tool: "generate_image" },
  video: { Icon: VideoIcon, label: "Video", tool: "generate_video" },
} as const;

/**
 * 对话内生图/生视频卡片。
 *
 * 数据流：卡片状态的唯一数据源是 React Query（GET /conversations/:id/media）；
 * 锚点（thread item）只带 generationId，状态全从 query 里按 id 取（设计 §前端职责）。
 * live media_update 由 use-conversation 钩子负责 invalidate 该 query，卡片自动刷新。
 */
export function MediaCard({
  conversationId,
  generationId,
  mediaType,
}: {
  conversationId: string;
  generationId: string;
  mediaType: "image" | "video";
}) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["conversation-media", conversationId],
    queryFn: () => listConversationMedia(conversationId),
    // 卡片首次出现时（live 锚点先于 query 落地）可能尚无该 generation，靠 media_update invalidate 补齐。
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const generation = data?.find((g) => g.id === generationId);

  // 查询加载中、或锚点已出现但 generation 尚未进入 query 数据（query 滞后）→ shimmer 占位。
  if (isLoading || !generation) {
    return <ShimmerPlaceholder mediaType={mediaType} prompt={null} />;
  }

  return (
    <MediaCardBody
      generation={generation}
      mediaType={mediaType}
      onAfterRegenerate={() => void refetch()}
    />
  );
}

/** 卡片主体：版本切换 / 资产展示 / 重新生成。generation 已确定存在。 */
function MediaCardBody({
  generation,
  mediaType,
  onAfterRegenerate,
}: {
  generation: MediaGeneration;
  mediaType: "image" | "video";
  onAfterRegenerate: () => void;
}) {
  // versions 按 createdAt desc，versions[0] 为最新版。当前查看的版本索引。
  const versions = generation.versions;
  const [versionIndex, setVersionIndex] = useState(0);

  // 重新生成后版本数变化 → 自动跳到最新版（index 0）。用渲染期校正而非 effect（避免 set-state-in-effect）。
  const [trackedCount, setTrackedCount] = useState(versions.length);
  if (trackedCount !== versions.length) {
    setTrackedCount(versions.length);
    setVersionIndex(0);
  }

  // 防御：versions 长度变化导致索引越界时夹到合法范围。
  const safeIndex = Math.min(versionIndex, versions.length - 1);
  const version = versions[safeIndex];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function openRegenerate() {
    setDraft(version.prompt); // 默认值 = 当前所看版本的 prompt
    setEditing(true);
  }

  async function submitRegenerate() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // 总是回传输入框当前值（即使未改动，语义一致——后端 prompt? 缺省路径只服务 API 直调）。
      // 沿用当前版本的参考图，让重生成行为可预期（不传则后端继承上一版，但显式传更明确）。
      await regenerateMedia(generation.id, draft, version.referenceVersionIds);
      setEditing(false);
      onAfterRegenerate();
    } finally {
      setSubmitting(false);
    }
  }

  const { Icon, label } = TYPE_META[mediaType];

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* 头部（常驻）：工具名 + 模型 + 状态。信息随当前查看的 version 联动。 */}
      <CardHeader version={version} mediaType={mediaType} />

      {/* 资产 / 状态区 */}
      <MediaSurface version={version} mediaType={mediaType} />

      {/* prompt（常驻）：当前版本完整传参，默认折叠 2 行可展开。 */}
      <PromptBlock prompt={version.prompt} />

      {/* 参考图（仅当前版本有引用时）：调用参数的一部分，缩略展示每张参考图。 */}
      <ReferenceRow referenceVersionIds={version.referenceVersionIds} />

      {/* 底栏：类型徽标 + 版本切换 + 重新生成 */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>

        {versions.length > 1 && (
          <div className="ml-1 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous version"
              disabled={safeIndex >= versions.length - 1}
              onClick={() => setVersionIndex((i) => Math.min(i + 1, versions.length - 1))}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-[3rem] text-center text-xs tabular-nums text-muted-foreground">
              v{versions.length - safeIndex} / {versions.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next version"
              disabled={safeIndex <= 0}
              onClick={() => setVersionIndex((i) => Math.max(i - 1, 0))}
            >
              <ChevronRight />
            </Button>
          </div>
        )}

        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            onClick={openRegenerate}
          >
            <RefreshCw className="size-3.5" />
            Regenerate
          </Button>
        )}
      </div>

      {/* 重新生成：行内展开 Textarea + 生成/取消 */}
      {editing && (
        <div className="space-y-2 border-t px-3 py-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Describe the image you want…"
            // 移动端必须 ≥16px（text-base）：iOS 对 <16px 的输入框聚焦会自动放大整页
            className="resize-none text-base md:text-sm"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={submitting}
              onClick={() => setEditing(false)}
            >
              <X className="size-3.5" />
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={submitting || !draft.trim()}
              onClick={() => void submitRegenerate()}
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Generate
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 状态 → 指示图标 + 文案 + badge 变体。头部状态指示共用。 */
const STATUS_META: Record<
  MediaStatus,
  { label: string; variant: "secondary" | "outline" | "destructive"; spin?: boolean }
> = {
  queued: { label: "Queued", variant: "secondary", spin: true },
  generating: { label: "Generating", variant: "secondary", spin: true },
  done: { label: "Done", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

/**
 * 卡片头部（所有状态常驻）：类型图标 + 工具名（等宽小字）+ 模型 badge + 状态指示。
 * 让用户一眼看清这是一次什么工具调用、用的哪个模型。信息全部取自当前查看的 version，
 * 故版本切换时随之联动。
 */
function CardHeader({
  version,
  mediaType,
}: {
  version: MediaVersion;
  mediaType: "image" | "video";
}) {
  const { Icon, tool } = TYPE_META[mediaType];
  const status = STATUS_META[version.status];
  const StatusIcon = status.spin
    ? Loader2
    : version.status === "failed"
      ? AlertCircle
      : CheckCircle2;

  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-mono text-xs text-foreground">{tool}</span>
      {version.model && (
        // shrink（覆盖 Badge 基础类的 shrink-0）+ min-w-0 + 内层 truncate：
        // 窄屏（手机）下长模型名截断省略，不把状态徽标挤出卡片
        <Badge variant="outline" className="min-w-0 shrink font-mono">
          <span className="truncate">{version.model}</span>
        </Badge>
      )}
      <Badge variant={status.variant} className="ml-auto">
        <StatusIcon className={status.spin ? "animate-spin" : undefined} />
        {status.label}
      </Badge>
    </div>
  );
}

/**
 * prompt 区（所有状态常驻）：当前版本的完整 prompt（传参/参考资源主体）。
 * 默认折叠为 2 行（line-clamp），可展开看全文。
 */
function PromptBlock({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!prompt) return null;

  return (
    <div className="border-t px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-1.5 text-left"
      >
        <ChevronDown
          className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
        />
        <p
          className={`text-xs leading-relaxed text-muted-foreground ${
            expanded ? "" : "line-clamp-2"
          }`}
        >
          <span className="font-medium text-foreground">Prompt: </span>
          {prompt}
        </p>
      </button>
    </div>
  );
}

/**
 * 参考图区（调用参数的一部分）：当前版本引用了图片时展示一行小缩略图。
 * 引用的必是 type=image 的版本（后端校验），故每张都用 <img>。悬停 title 显示 versionId。
 */
function ReferenceRow({ referenceVersionIds }: { referenceVersionIds: string[] }) {
  if (referenceVersionIds.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-t px-3 py-2.5">
      <span className="shrink-0 text-xs font-medium text-foreground">Reference</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {referenceVersionIds.map((id) => (
          <ReferenceThumb key={id} versionId={id} />
        ))}
      </div>
    </div>
  );
}

/** 单张参考图缩略：复用 fetchMediaAssetBlob 取 blob → objectURL。28px 方块，加载中 shimmer。 */
function ReferenceThumb({ versionId }: { versionId: string }) {
  const { data: blob } = useQuery({
    queryKey: ["media-asset", versionId],
    queryFn: () => fetchMediaAssetBlob(versionId),
    staleTime: Infinity, // 同一 version 资产不可变
    refetchOnWindowFocus: false,
  });

  // blob → objectURL（渲染期 useMemo 派生，不在 effect 里 setState）；revoke 只在真正卸载时做，
  // 据 ref 取最新 url，避免 Strict Mode memo 双跑误伤正在显示的 URL（见 media-card AssetSurface 注）。
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  if (!url) {
    return <Skeleton className="size-7 rounded-md" />;
  }
  return (
    // 参考图同样是带鉴权 fetch 的 blob objectURL，next/image 无法优化，用原生 <img>。
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Reference image"
      title={versionId}
      className="size-7 rounded-md border object-cover"
    />
  );
}

/** 按版本状态渲染资产区：queued/generating → shimmer；done → 资产；failed → 错误。 */
function MediaSurface({
  version,
  mediaType,
}: {
  version: MediaVersion;
  mediaType: "image" | "video";
}) {
  if (version.status === "queued" || version.status === "generating") {
    // prompt 已由卡片的 PromptBlock 常驻展示，这里不再重复一行摘要。
    return <ShimmerPlaceholder mediaType={mediaType} prompt={null} />;
  }
  if (version.status === "failed") {
    return <FailedSurface error={version.error} />;
  }
  return <AssetSurface key={version.id} versionId={version.id} mediaType={mediaType} />;
}

/** 生成中：shimmer 渐变 + 转圈 + 类型图标 + prompt 摘要一行。 */
function ShimmerPlaceholder({
  mediaType,
  prompt,
}: {
  mediaType: "image" | "video";
  prompt: string | null;
}) {
  const { Icon } = TYPE_META[mediaType];
  return (
    <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-3 overflow-hidden bg-muted">
      {/* shimmer：左右扫过的高光渐变。keyframe + 动画类在 globals.css（组件内 <style> 客户端不注入）。 */}
      <span
        className="animate-media-shimmer pointer-events-none absolute inset-0 -translate-x-full"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, var(--color-foreground), transparent)",
          opacity: 0.06,
        }}
      />
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-5" />
        <Loader2 className="size-4 animate-spin" />
      </div>
      {prompt && (
        <p className="line-clamp-1 max-w-[80%] px-4 text-center text-xs text-muted-foreground">
          {prompt}
        </p>
      )}
    </div>
  );
}

/** 失败：destructive 边框 + 错误文案。重试由底栏「重新生成」承担（设计 §操作）。 */
function FailedSurface({ error }: { error: string | null }) {
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 border-2 border-destructive/40 bg-destructive/5 px-4 text-center">
      <p className="text-sm font-medium text-destructive">Generation failed</p>
      <p className="line-clamp-3 text-xs text-muted-foreground">
        {error || "Unknown error. Click “Regenerate” below to retry."}
      </p>
    </div>
  );
}

/** 完成：fetch 带 token 的二进制资产 → blob objectURL → <img>/<video>。cleanup 时 revoke。 */
function AssetSurface({
  versionId,
  mediaType,
}: {
  versionId: string;
  mediaType: "image" | "video";
}) {
  const { data: blob, isLoading } = useQuery({
    queryKey: ["media-asset", versionId],
    queryFn: () => fetchMediaAssetBlob(versionId),
    staleTime: Infinity, // 同一 version 资产不可变，缓存到内存即可
    refetchOnWindowFocus: false,
  });

  // blob → objectURL。渲染期用 useMemo 派生（set-state-in-effect 是 error 级，不能在 effect 里 setUrl）。
  // 一个 AssetSurface 只服务单个 versionId（版本切换会换 key → 整卡卸载重建），故同一实例内 blob 稳定、
  // URL 只在挂载时创建一次。useMemo 不在渲染期 revoke（在渲染期 revoke 会被 Strict Mode 的 memo 双跑
  // 误伤当前 URL，导致 <img> 解码失败 naturalWidth=0）；revoke 只在真正卸载时做。
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  // 把最新 url 同步进 ref（在 effect 里写，不在渲染期写 ref），卸载时据此 revoke——
  // 只在组件真正销毁时回收一次，绝不动正在显示的 URL。
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  if (isLoading || !url) {
    return <Skeleton className="aspect-video w-full rounded-none" />;
  }

  if (mediaType === "video") {
    return (
      <video
        src={url}
        controls
        className="aspect-video w-full bg-black object-contain"
      />
    );
  }
  return (
    // 资产是 blob objectURL（运行时生成、带鉴权 fetch），next/image 无法优化此类源，故用原生 <img>。
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="Generated image" className="w-full bg-muted object-contain" />
  );
}
