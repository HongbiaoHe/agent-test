"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsNav } from "./_components/settings-nav";

// /settings 外壳：返回上一个页面 + 标题 + 左侧分区导航（mobile 折叠为顶部横向）。
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <TooltipProvider>
      {/* 外壳自身是滚动容器（满视口宽，滚动条贴页面右缘）；
          scrollbar-gutter 常驻预留滚动条位，切换 tab 长短内容时居中区域不再横移。 */}
      <main className="h-screen overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-5xl space-y-6 p-6 font-sans sm:p-8">
          <header className="space-y-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.back()}
              className="-ml-2 text-muted-foreground"
            >
              <ArrowLeft className="size-4" /> Back
            </Button>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          </header>
          <div className="flex flex-col gap-6 sm:flex-row">
            {/* desktop 下导航 sticky 固定，滚动时只有右侧内容区移动 */}
            <aside className="shrink-0 self-start sm:sticky sm:top-8 sm:w-44">
              <SettingsNav />
            </aside>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        </div>
      </main>
    </TooltipProvider>
  );
}
