/**
 * HTTP Range 请求头解析（纯函数，单测见 http-range.test.ts）：spark-preview:// 给 <video>/<audio> 按字节区间供数据。
 * 只支持单个区间（媒体元素只发单区间）；多区间按「不支持」处理，返回整份文件。
 */

export type RangeResult =
  /** 没有 Range 头 / 不认识的单位 / 多区间：按整份文件 200 返回 */
  | { kind: 'full' }
  /** 合法区间 [start, end]（含两端） */
  | { kind: 'partial'; start: number; end: number }
  /** 区间落在文件之外：416 */
  | { kind: 'unsatisfiable' };

export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'full' };
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'full' };
  if (a === '') {
    // bytes=-N：最后 N 个字节
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
