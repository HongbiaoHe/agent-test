"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchMediaAssetBlob,
  listConversationMedia,
  type MediaGeneration,
  type MediaVersion,
  regenerateMedia,
} from "@/lib/api";

/** 类型 → 图标 / 文案，生成中占位与失败态共用。 */
const TYPE_META = {
  image: { Icon: ImageIcon, label: "图片" },
  video: { Icon: VideoIcon, label: "视频" },
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
      await regenerateMedia(generation.id, draft);
      setEditing(false);
      onAfterRegenerate();
    } finally {
      setSubmitting(false);
    }
  }

  const { Icon, label } = TYPE_META[mediaType];

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* 资产 / 状态区 */}
      <MediaSurface version={version} mediaType={mediaType} />

      {/* 底栏：类型徽标 + 版本切换 + 重新生成 */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>

        {versions.length > 1 && (
          <div className="ml-1 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一个版本"
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
              aria-label="下一个版本"
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
            重新生成
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
            placeholder="描述你想要的画面…"
            className="resize-none text-sm"
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
              取消
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
              生成
            </Button>
          </div>
        </div>
      )}
    </div>
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
    return <ShimmerPlaceholder mediaType={mediaType} prompt={version.prompt} />;
  }
  if (version.status === "failed") {
    return <FailedSurface error={version.error} />;
  }
  return <AssetSurface versionId={version.id} mediaType={mediaType} />;
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
      <p className="text-sm font-medium text-destructive">生成失败</p>
      <p className="line-clamp-3 text-xs text-muted-foreground">
        {error || "未知错误，请点击下方「重新生成」重试。"}
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
    <img src={url} alt="生成的图片" className="w-full bg-muted object-contain" />
  );
}
