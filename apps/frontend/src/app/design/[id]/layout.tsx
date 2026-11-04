import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Layered Design",
  description: "Editable layered image design with an AI design agent",
};

export default function DesignEditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      {/* 全屏外壳：静态 h-screen（dvh 在 Electron 预览里会动态重算导致整页塌顶），
          overflow-clip 而不是 hidden（hidden 仍能被 focus/scrollIntoView 程序化滚动，同画布外壳） */}
      <div data-app-shell className="h-screen overflow-clip [@media(pointer:coarse)]:h-svh">
        {children}
      </div>
    </TooltipProvider>
  );
}
