"use client";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import { useMemo } from "react";

// 按需注册（core 不含语言），控制包体；扩展语言在此追加注册并补 LANG_BY_EXT
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);

/** 文件扩展名 → highlight.js 语言名（detail-panel 按 file_path 推断用） */
const LANG_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

/** 从文件路径推断高亮语言；未知扩展返回 undefined（纯文本展示）。 */
export function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? LANG_BY_EXT[ext] : undefined;
}

/**
 * 代码高亮渲染：language 已注册时输出 hljs 高亮 HTML（hljs 自身做转义，安全），
 * 否则原样文本。配色见 globals.css 的 --syntax-* token（亮暗自适应）。
 */
export function HighlightedCode({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      return null;
    }
  }, [code, language]);

  if (html === null) return <code className={className}>{code}</code>;
  return (
    <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
