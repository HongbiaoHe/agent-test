/**
 * 预览素材的地址：main 的 spark-preview:// 源（工作区根即站点根，支持 Range）+ / + 工作区相对路径（逐段编码）。
 */
export function mediaUrl(origin: string, workspacePath: string): string {
  return `${origin.replace(/\/+$/, '')}/${workspacePath.split('/').map(encodeURIComponent).join('/')}`;
}
