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

import type { Detail, FileDetail, ToolDetail } from "../_data/mock";

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre text-foreground/90">
      {children}
    </pre>
  );
}

function StatusBadge({ status }: { status: ToolDetail["status"] }) {
  if (status === "running") {
    return (
      <Badge variant="secondary">
        <Loader className="animate-spin" />
        运行中
      </Badge>
    );
  }
  if (status === "error") {
    return <Badge variant="destructive">失败</Badge>;
  }
  return (
    <Badge variant="outline">
      <Check />
      完成
    </Badge>
  );
}

function ToolView({ detail }: { detail: ToolDetail }) {
  return (
    <Tabs
      defaultValue="result"
      className="flex min-h-0 flex-1 flex-col gap-0 px-4 py-3"
    >
      <div className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-sm font-medium">
            {detail.name}
          </code>
          <StatusBadge status={detail.status} />
          {detail.durationLabel && (
            <span className="text-xs text-muted-foreground">
              耗时 {detail.durationLabel}
            </span>
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
          <CodeBlock>{detail.result}</CodeBlock>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="args" className="mt-3 min-h-0 flex-1">
        <ScrollArea className="h-full">
          <CodeBlock>{JSON.stringify(detail.args, null, 2)}</CodeBlock>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

function FileInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  );
}

function FileView({ detail }: { detail: FileDetail }) {
  return (
    <Tabs
      defaultValue="preview"
      className="flex min-h-0 flex-1 flex-col gap-0 px-4 py-3"
    >
      <div className="space-y-1 pb-3">
        <p className="truncate font-mono text-xs text-muted-foreground">
          {detail.path}
        </p>
      </div>
      <TabsList className="w-full">
        <TabsTrigger value="preview" className="flex-1">
          预览
        </TabsTrigger>
        <TabsTrigger value="info" className="flex-1">
          信息
        </TabsTrigger>
      </TabsList>
      <TabsContent value="preview" className="mt-3 min-h-0 flex-1">
        <ScrollArea className="h-full">
          <CodeBlock>{detail.content}</CodeBlock>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="info" className="mt-3 min-h-0 flex-1">
        <div className="rounded-lg border px-3">
          <FileInfoRow label="路径" value={detail.path} />
          <FileInfoRow label="语言" value={detail.language} />
          <FileInfoRow label="大小" value={detail.sizeLabel} />
          <FileInfoRow label="行数" value={String(detail.lines)} />
        </div>
      </TabsContent>
    </Tabs>
  );
}

export function DetailPanel({
  detail,
  onClose,
  className,
}: {
  detail: Detail;
  onClose: () => void;
  className?: string;
}) {
  const title = detail.kind === "tool" ? "工具调用" : "文件详情";
  const heading = detail.name;

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
            {title}
          </span>
          <span className="truncate text-sm font-medium">{heading}</span>
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
      {detail.kind === "tool" ? (
        <ToolView detail={detail} />
      ) : (
        <FileView detail={detail} />
      )}
    </aside>
  );
}
