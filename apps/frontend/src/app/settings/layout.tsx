import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsNav } from "./_components/settings-nav";

// /settings 外壳：返回 agent + 标题 + 左侧分区导航（mobile 折叠为顶部横向）。
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-5xl space-y-6 p-6 font-sans sm:p-8">
        <header className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/agent" />}
            className="-ml-2 text-muted-foreground"
          >
            <ArrowLeft className="size-4" /> Back to conversations
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        </header>
        <div className="flex flex-col gap-6 sm:flex-row">
          <aside className="shrink-0 sm:w-44">
            <SettingsNav />
          </aside>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </main>
    </TooltipProvider>
  );
}
