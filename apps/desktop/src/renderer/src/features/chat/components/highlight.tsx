"use client";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

// 按需注册（core 不含语言），控制包体；扩展语言在此追加注册并补 LANG_BY_EXT
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml); // 覆盖 html/svg/vue 模板
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);

/** 文件扩展名 → highlight.js 语言名（按 file_path 推断高亮用） */
const LANG_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  go: "go",
  rs: "rust",
};

/** 从文件路径推断高亮语言；未知扩展返回 undefined（纯文本展示）。 */
export function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? LANG_BY_EXT[ext] : undefined;
}

/**
 * 剥离 read 类结果的行号前缀（cat -n / awk 式 `     12\t内容`，可能叠多层）。
 * 仅当所有非空行都带 `数字\t` 前缀时才剥（整列一致 = 行号列；内容行偶然
 * 以数字开头不会全行命中），逐层剥到内容行不再匹配为止。只影响展示。
 *
 * 后端 GuardedSandbox.read（含 /sandbox/file 文本预览）与 agent read_file 工具结果
 * 都是这种带行号格式，故收敛在 highlight 模块供 detail-panel / file-preview 共用。
 */
export function stripLineNumbers(text: string): string {
  let lines = text.split("\n");
  const isNumbered = (ls: string[]) =>
    ls.some((l) => l !== "") && ls.every((l) => l === "" || /^\s*\d+\t/.test(l));
  while (isNumbered(lines)) {
    lines = lines.map((l) => (l === "" ? l : l.replace(/^\s*\d+\t/, "")));
  }
  return lines.join("\n");
}

/** 内容像 JSON（能 parse 的对象/数组）时返回 "json"，否则 undefined。 */
export function jsonLangIfParses(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    JSON.parse(t);
    return "json";
  } catch {
    return undefined;
  }
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

/**
 * 通用代码/文本查看器：一处收敛「剥行号 + 推断语言 + 高亮 + 等宽块样式」。
 * detail-panel 的工具结果与 file-preview 的文件预览共用，是项目唯一的代码渲染出口。
 *
 * 语言优先级：显式 language > 按 path 扩展名推断 > 内容像 JSON 兜底。
 * strip 默认开（去 read 行号列）；调用方传入已是纯内容时设 false 也无副作用（幂等）。
 */
export function CodeViewer({
  text,
  path,
  language,
  strip = true,
  className,
}: {
  text: string;
  path?: string;
  language?: string;
  strip?: boolean;
  className?: string;
}) {
  const content = strip ? stripLineNumbers(text) : text;
  const lang = language ?? langFromPath(path) ?? jsonLangIfParses(content);
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90",
        className,
      )}
    >
      <HighlightedCode code={content} language={lang} />
    </pre>
  );
}
