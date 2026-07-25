import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CanvasWrapper } from "./_components/canvas-wrapper";

export const metadata: Metadata = {
  title: "Canvas workflow",
  description: "A node canvas the agent wires up for you",
};

export default function CanvasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* 侧栏折叠的预水合脚本不在这里，在根 layout —— 放在本层会在软导航进入 /canvas 时
          被 React 在客户端渲染，既报 "Encountered a script tag..." 又根本不执行。 */}
      {/* 全屏外壳：细指针用静态 h-screen（dvh 在 Electron 预览里会动态重算导致整页塌顶）。
          触屏用 h-svh 而不是 h-dvh —— svh 是「地址栏显示时」的小视口，恒定不变；dvh 会随
          地址栏收放跳动。配合 globals.css 里 [data-app-shell] 的整页禁滚（地址栏因此不再收放），
          svh 就精确等于可视区；即便某些浏览器仍收起地址栏，svh 偏小也只是底部留白，
          不会把内容顶出视野。 */}
      <div
        data-app-shell
        className="h-screen overflow-clip [@media(pointer:coarse)]:h-svh"
      >
        <CanvasWrapper />
        {children}
      </div>
    </TooltipProvider>
  );
}
