"use client";

import { useParams } from "next/navigation";

import { CanvasShell } from "./canvas-shell";

/**
 * 读取 URL 的画布 id（/canvas/[id]）注入 CanvasShell。放在 [id] 的 layout 层，
 * 保证换画布（/canvas/a → /canvas/b）时 shell 不重挂载（会话列表查询不重置）。
 */
export function CanvasWrapper() {
  const params = useParams<{ id?: string }>();
  return <CanvasShell sessionId={params?.id ?? null} />;
}
