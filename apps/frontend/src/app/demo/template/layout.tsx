import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Agent 对话界面 · Demo",
  description: "AI agent 对话界面模板（manus 风格）",
};

export default function DemoTemplateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <div className="h-dvh overflow-hidden">{children}</div>
    </TooltipProvider>
  );
}
