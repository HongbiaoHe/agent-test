"use client";

import { Check, Loader, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type { ThreadItem } from "../_lib/thread";

type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
      {children}
    </pre>
  );
}

export function DetailPanel({
  tool,
  onClose,
  className,
}: {
  tool: ToolItem;
  onClose: () => void;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        // mobile：全屏覆盖；desktop：内联第三栏
        "fixed inset-0 z-40 flex h-full w-full flex-col bg-card duration-200 animate-in fade-in",
        "lg:static lg:z-auto lg:w-96 lg:shrink-0 lg:border-l",
        className,
      )}
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
            工具调用
          </span>
          <span className="truncate text-sm font-medium">{tool.name}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭详情面板"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>

      <Tabs
        defaultValue="result"
        className="flex min-h-0 flex-1 flex-col gap-0 px-4 py-3"
      >
        <div className="space-y-2 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-sm font-medium">
              {tool.name}
            </code>
            {tool.done ? (
              <Badge variant="outline">
                <Check />
                完成
              </Badge>
            ) : (
              <Badge variant="secondary">
                <Loader className="animate-spin" />
                运行中
              </Badge>
            )}
          </div>
        </div>
        <TabsList className="w-full">
          <TabsTrigger value="result" className="flex-1">
            结果
          </TabsTrigger>
          <TabsTrigger value="args" className="flex-1">
            参数
          </TabsTrigger>
        </TabsList>
        <TabsContent value="result" className="mt-3 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <CodeBlock>{tool.result ?? "（暂无结果）"}</CodeBlock>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="args" className="mt-3 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <CodeBlock>{JSON.stringify(tool.args, null, 2)}</CodeBlock>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
