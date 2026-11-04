"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { use } from "react";

import { EditorShell } from "../_components/editor-shell";
import { designApi } from "../_lib/api";

export default function DesignEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // 快照只取一次：之后的变更全走 socket 增量（staleTime 无限，切回标签页不重拉覆盖本地乐观态）
  const snap = useQuery({
    queryKey: ["design", "snapshot", id],
    queryFn: () => designApi.get(id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (snap.isError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        打不开这份设计稿：{snap.error.message}
      </div>
    );
  }
  if (!snap.data) {
    return (
      <div className="flex h-full items-center justify-center bg-workspace">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // key：切换设计稿时整套编辑器状态重建
  return <EditorShell key={snap.data.id} snapshot={snap.data} />;
}
