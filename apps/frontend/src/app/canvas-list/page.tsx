import type { Metadata } from "next";

import { CanvasGallery } from "../canvas/_components/canvas-gallery";

export const metadata: Metadata = {
  title: "Canvases",
  description: "Every board you have, newest first",
};

/**
 * 画布索引页。原先它是 /canvas 上「没选中任何画布」的那一态（由 CanvasShell 兜住），
 * 现在 /canvas 让给了产品介绍页，索引页独立成这条路由。
 *
 * 直接挂 CanvasGallery，不再穿过 CanvasShell：索引页要的只有列表本身——
 * 画布内的悬浮面板、对话、缩放在这里都无从谈起（CanvasShell 里那些也全都 gate 在
 * sessionId 上）。少一层就少一份 useCanvas(null) 的空转。
 *
 * data-app-shell + h-screen：这一页自己不滚，滚动发生在 CanvasGallery 内部
 * （它是 h-full overflow-y-auto，需要一个定高的父级）。触屏用 h-svh 的理由同
 * canvas/[id]/layout.tsx。
 */
export default function CanvasListPage() {
  return (
    <div
      data-app-shell
      className="h-screen overflow-clip [@media(pointer:coarse)]:h-svh"
    >
      <CanvasGallery />
    </div>
  );
}
