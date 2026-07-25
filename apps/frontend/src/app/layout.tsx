import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { auth } from "@/auth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentSpark",
  description:
    "An end-to-end Agent platform: planning, tool-calling, human-in-the-loop, skills, and real-time streaming.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // 浏览器扩展/远程框架工具会在 React 前往 <html> 注入属性（如 __gcrremoteframetoken），
      // 抑制由此产生的 hydration 警告
      suppressHydrationWarning
    >
      <head>
        {/*
          画布侧栏折叠的预水合脚本（同 next-themes 的思路）：首屏绘制前把折叠缓存写到 <html>
          的 data 属性上，侧栏宽度纯 CSS 据此决定（见 canvas-shell）。否则 SSR 首帧总是展开态，
          水合后才读到 localStorage → 刷新会闪现一下侧栏。

          为什么放在根 layout 而不是 canvas/layout：软导航进入 /canvas 时 React 会在客户端
          渲染那一层，客户端渲染的 <script> 既不执行、还会报 "Encountered a script tag while
          rendering React component"。根 layout 位于所有路由段之上，软导航不重渲染它，所以只在
          SSR 输出一次。代价是任何路由都会跑这两行 localStorage 读取，可忽略。

          用原生 <script> 而非 next/script：beforeInteractive 会把执行推迟到 Next 运行时的
          __next_s 队列（不阻塞水合），那就赶不上首帧，防闪的目的就没了。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement,f=function(k){return localStorage.getItem('canvas.panel.'+k+'.collapsed')==='1'?'collapsed':'open'};d.dataset.canvasLeft=f('left');d.dataset.canvasRight=f('right')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
