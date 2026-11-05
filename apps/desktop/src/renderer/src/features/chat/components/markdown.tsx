"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { type FileViewerApi, useFileViewer } from "@/features/viewer/viewer-context";
import { cn } from "@/lib/utils";

/**
 * 桌面端：链接不能让应用窗口跳走。能预览的（图片 / 视频 / 音频 / md / 工作区文件）开全屏预览，
 * 其余 http(s) 交给系统浏览器；Markdown 里的图片点开看大图。
 */
function components(viewer: FileViewerApi | null): Components {
  return {
    a: ({ node: _node, href, onClick: _onClick, ...rest }) => (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!href || viewer?.openHref(href)) return;
          if (/^https?:\/\//i.test(href)) void window.desktop.openExternal(href);
        }}
      />
    ),
    img: ({ node: _node, src, alt, className, ...rest }) => (
      // 运行时 URL，用原生 <img>
      <img
        {...rest}
        src={src}
        alt={alt}
        className={cn("my-2 max-h-80 cursor-zoom-in rounded-lg border border-border", className)}
        onClick={(e) => {
          if (!viewer || typeof src !== "string" || !/^https?:\/\//i.test(src)) return;
          e.preventDefault();
          e.stopPropagation(); // 图片外面包着链接时，只开图片
          viewer.show({ source: "url", url: src, kind: "image", name: alt || src.split("/").pop() || src });
        }}
      />
    ),
  };
}

/**
 * 渲染 agent 输出的 Markdown（GFM：表格 / 列表 / 代码块 / 删除线等）。
 * 样式全部走设计系统语义 token，亮暗两套自适应；不渲染原始 HTML（react-markdown 默认安全）。
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const viewer = useFileViewer();
  return (
    <div
      className={cn(
        "overflow-x-auto text-sm leading-relaxed text-foreground/90",
        // 段落 / 标题
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-medium",
        // 列表
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        // 强调 / 链接
        "[&_strong]:font-semibold [&_em]:italic",
        "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:opacity-80",
        // 行内代码 / 代码块
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs",
        // 引用 / 分隔线
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_hr]:my-4 [&_hr]:border-border",
        // 表格（窄屏靠最外层 overflow-x-auto 横向滚动）
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components(viewer)}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
