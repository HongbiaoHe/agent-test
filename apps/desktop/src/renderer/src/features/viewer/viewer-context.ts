/**
 * 预览弹窗的上下文：Markdown 等渲染处只拿 open 函数，不关心弹窗在哪、当前是哪个会话。
 * 拆成单独文件是为了避免 markdown.tsx ↔ file-viewer.tsx 循环引用（弹窗里也要渲染 Markdown）。
 */
import { createContext, useContext } from 'react';
import type { PreviewTarget } from './preview-target';

export interface FileViewerApi {
  /** 链接 → 能预览就打开弹窗并返回 true；不能预览返回 false（调用方自行交给系统浏览器） */
  openHref(href: string): boolean;
  /** 已知类型的目标直接打开（如 Markdown 里的图片：src 不一定带扩展名） */
  show(target: PreviewTarget): void;
}

export const FileViewerContext = createContext<FileViewerApi | null>(null);

export function useFileViewer(): FileViewerApi | null {
  return useContext(FileViewerContext);
}
