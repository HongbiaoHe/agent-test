"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  Loader2,
} from "lucide-react";
import { useState } from "react";

import { fetchSandboxDir, type SandboxDirEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "py", "java", "kt",
  "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "vue", "svelte", "sh",
  "bash", "zsh", "css", "scss", "sass", "less", "html", "htm", "xml", "sql",
]);
const JSON_EXTS = new Set(["json", "jsonc", "yml", "yaml", "toml"]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);
const DOC_EXTS = new Set(["md", "markdown", "mdx", "txt", "text", "log"]);

/** 按扩展名挑文件图标（纯装饰，未知类型回退通用文件图标）。 */
function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (CODE_EXTS.has(ext)) return <FileCode2 className={className} />;
  if (JSON_EXTS.has(ext)) return <FileJson className={className} />;
  if (IMAGE_EXTS.has(ext)) return <FileImage className={className} />;
  if (DOC_EXTS.has(ext)) return <FileText className={className} />;
  return <File className={className} />;
}

/** 缩进：每层左移一档，根级留出与图标对齐的基线。 */
function indentStyle(depth: number) {
  return { paddingInlineStart: `${depth * 12 + 6}px` };
}

/**
 * 工作区文件树（按目录懒加载）。根级由 DirChildren(dir="") 渲染；
 * 目录节点展开时才挂载其 DirChildren —— react-query 随之触发，「不展开不加载」。
 */
export function FileTree({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <DirChildren dir="" depth={0} selected={selected} onSelect={onSelect} />
  );
}

function DirChildren({
  dir,
  depth,
  selected,
  onSelect,
}: {
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["sandbox-dir", dir],
    queryFn: () => fetchSandboxDir(dir),
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
        style={indentStyle(depth)}
      >
        <Loader2 className="size-3 animate-spin" />
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <p
        className="py-1 text-xs text-destructive"
        style={indentStyle(depth)}
      >
        {error instanceof Error ? error.message : "Failed to load"}
      </p>
    );
  }

  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <p
        className="py-1 text-xs text-muted-foreground"
        style={indentStyle(depth)}
      >
        {depth === 0 ? "No files in the workspace yet." : "Empty"}
      </p>
    );
  }

  return (
    <ul>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: SandboxDirEntry;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (entry.isDir) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-accent"
          style={indentStyle(depth)}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{entry.name}</span>
        </button>
        {/* 仅展开时挂载 → 触发该目录的懒加载 */}
        {open && (
          <DirChildren
            dir={entry.path}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </li>
    );
  }

  const isSelected = selected === entry.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(entry.path)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-accent",
          isSelected && "bg-accent font-medium",
        )}
        // 文件图标占据折叠箭头的位置，故比目录多缩进一档对齐
        style={indentStyle(depth + 1)}
      >
        <FileTypeIcon
          name={entry.name}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate font-mono text-xs">{entry.name}</span>
      </button>
    </li>
  );
}
