/**
 * token 数的约略写法（顶栏等处只要量级，不要精确值）：按界面语言的紧凑记数——
 * zh-CN「2594.4万」、en「25.9M」、zh-Hant「2594.4萬」；1000 以下原样。精确值留给明细弹窗 / 悬停提示。
 */
export function formatTokensCompact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
