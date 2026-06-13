"use client";

import { Check, Download, Loader, X } from "lucide-react";

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
import {
  CodeViewer,
  jsonLangIfParses,
  langFromPath,
  stripLineNumbers,
} from "./highlight";

type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

/** 工具结果/参数的等宽块——薄封装 CodeViewer（项目唯一的代码渲染出口）。 */
function CodeBlock({
  children,
  language,
}: {
  children: string;
  language?: string;
}) {
  return <CodeViewer text={children} language={language} />;
}

type ContentBlock = { type: string } & Record<string, unknown>;

/**
 * 工具结果可能是纯文本，也可能是 LangChain content block 数组
 * （[{ type: "text", text: "..." }]，thread 层已 JSON 序列化成字符串）。
 * 尝试解析回结构；不是 block 结构就返回 null，调用方按原文展示。
 */
function parseContentBlocks(s: string): ContentBlock[] | null {
  const t = s.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    if (
      arr.length > 0 &&
      arr.every(
        (b) =>
          b !== null &&
          typeof b === "object" &&
          typeof (b as { type?: unknown }).type === "string",
      )
    ) {
      return arr as ContentBlock[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 结果页签的格式化展示：text 块只展示内容本身（换行/缩进原样保留、剥离行号列、
 * 按文件扩展名/内容推断语言做高亮），其他类型的块带 type 标签、回退为格式化 JSON；
 * 非 block 结构按原文展示（同样剥行号）。
 */
function ResultView({ result, language }: { result?: string; language?: string }) {
  if (!result) return <CodeBlock>(No result yet)</CodeBlock>;
  const blocks = parseContentBlocks(result);
  if (!blocks) {
    const text = stripLineNumbers(result);
    return <CodeBlock language={language ?? jsonLangIfParses(text)}>{text}</CodeBlock>;
  }
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.type === "text" && typeof b.text === "string") {
          const text = stripLineNumbers(b.text);
          return (
            <CodeBlock key={i} language={language ?? jsonLangIfParses(text)}>
              {text}
            </CodeBlock>
          );
        }
        return (
          <div key={i} className="space-y-1">
            <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {b.type}
            </span>
            <CodeBlock language="json">{JSON.stringify(b, null, 2)}</CodeBlock>
          </div>
        );
      })}
    </div>
  );
}

/**
 * write_file 等写文件工具的参数里带 file_path + content 时，可据此直接下载文件。
 * 后端用 deepagents StateBackend（虚拟 FS，不落磁盘），故文件内容只在工具参数里。
 */
function downloadableFile(
  args: unknown,
): { name: string; content: string } | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.content !== "string") return null;
  // 去掉 deepagents 虚拟根的前导斜杠，取文件名
  const path = typeof a.file_path === "string" ? a.file_path : "";
  const name = path.split("/").filter(Boolean).pop() || "download.txt";
  return { name, content: a.content };
}

function triggerDownload(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const file = downloadableFile(tool.args);
  // 读/写文件类工具按 file_path 扩展名推断结果高亮语言（如 .py → python）
  const argPath = (tool.args as { file_path?: unknown } | null)?.file_path;
  const resultLang = langFromPath(
    typeof argPath === "string" ? argPath : undefined,
  );

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
            Tool call
          </span>
          <span className="truncate text-sm font-medium">{tool.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {file && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerDownload(file.name, file.content)}
            >
              <Download />
              Download
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close detail panel"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
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
                Done
              </Badge>
            ) : (
              <Badge variant="secondary">
                <Loader className="animate-spin" />
                Running
              </Badge>
            )}
          </div>
        </div>
        <TabsList className="w-full">
          <TabsTrigger value="result" className="flex-1">
            Result
          </TabsTrigger>
          <TabsTrigger value="args" className="flex-1">
            Arguments
          </TabsTrigger>
        </TabsList>
        <TabsContent value="result" className="mt-3 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <ResultView result={tool.result} language={resultLang} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="args" className="mt-3 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <CodeBlock language="json">
              {JSON.stringify(tool.args, null, 2)}
            </CodeBlock>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
