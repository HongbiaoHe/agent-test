import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CanvasWrapper } from "./_components/canvas-wrapper";

export const metadata: Metadata = {
  title: "画布工作流",
  description: "AI 自动化搭建的节点工作流画布",
};

export default function CanvasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* 与 /agent 同：静态 h-screen + overflow-clip，触屏改 dvh（见 agent/layout 注释）。 */}
      <div className="h-screen overflow-clip [@media(pointer:coarse)]:h-dvh">
        <CanvasWrapper />
        {children}
      </div>
    </TooltipProvider>
  );
}
