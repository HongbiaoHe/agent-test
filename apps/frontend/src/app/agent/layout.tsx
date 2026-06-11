import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Agent Chat",
  description: "Three-column AI agent chat interface (manus style)",
};

export default function AgentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* 外壳满屏高度用静态 100vh（h-screen）而非动态 100dvh：dvh 会随渲染时机动态重算，
          在 Electron 内嵌预览里发消息/流式那阵会瞬时抖动→整页塌到顶再恢复；100vh 静态、桌面端等价、
          全平台支持且绝不回退成 auto。
          例外：触屏设备（pointer:coarse，即手机/平板，Electron/桌面是 pointer:fine 不受影响）改用
          100dvh——手机浏览器工具栏收展会改变可视高度，静态 100vh 会让底部输入框被工具栏压住。
          两条独立规则（非同名属性兜底对），Lightning CSS 不会删；不支持 dvh 的老浏览器按级联回退 100vh。
          overflow-clip 而非 overflow-hidden：hidden 仍会建立滚动容器，可被 focus()（如发送按钮，
          浏览器默认 focus 会把元素滚进视口）/scrollIntoView 程序化滚动——发消息那帧内层尚未 clamp 时
          会把整个满屏框架滚起来、连顶栏带侧栏一起被顶上去且无法滚回。clip 不建立滚动容器、物理上不可滚，
          根除这一整类「整页被顶」问题；裁剪效果与 hidden 等价。 */}
      <div className="h-screen overflow-clip [@media(pointer:coarse)]:h-dvh">
        {children}
      </div>
    </TooltipProvider>
  );
}
