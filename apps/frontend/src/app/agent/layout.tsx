import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Agent 会话",
  description: "AI agent 三栏对话界面（manus 风格）",
};

export default function AgentLayout({
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
