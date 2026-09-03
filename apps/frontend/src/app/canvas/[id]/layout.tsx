import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CanvasWrapper } from "../_components/canvas-wrapper";

export const metadata: Metadata = {
  title: "Canvas workflow",
  description: "A node canvas the agent wires up for you",
};

export default function CanvasBoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* 这层外壳只管「打开了某块画布」这一种页面（/canvas/[id]）。/canvas 是产品介绍页、
          /canvas-list 是索引页，都不该被钉进全屏外壳里——[data-app-shell] 会让整页禁滚
          （见 globals.css 的 html:has([data-app-shell])），那两页都要能滚。

          放在 [id] 这一层而不是 /canvas 段：切换画布（/canvas/a → /canvas/b）时
          layout 不重挂载，CanvasShell 与它持有的 socket 订阅、面板状态都留着。 */}
      {/* 侧栏折叠的预水合脚本不在这里，在根 layout —— 放在本层会在软导航进入时
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
