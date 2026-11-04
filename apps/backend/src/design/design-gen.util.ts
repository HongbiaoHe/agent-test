import type { DesignDocument, ImageLayer } from '@agent-test/design-schema';

export const DESIGN_GEN_QUEUE = 'design-gen';

/** 生成队列的一单：单图层生成，或对一个图层拆层（kind=decompose，完成后它被子图层替换）。 */
export interface DesignGenJob {
  docId: string;
  layerId: string;
  jobId: string;
  kind?: 'generate' | 'decompose';
  /** 拆层：指定要拆出哪些元素（可选） */
  prompt?: string;
}

/** 仍在等这一单的图层：同 id、仍是 generating、jobId 没被新一次生成覆盖。 */
export function findGenerating(
  doc: DesignDocument,
  job: DesignGenJob,
): ImageLayer | null {
  const layer = doc.layers.find((l) => l.id === job.layerId);
  if (layer?.type !== 'image') return null;
  if (layer.status !== 'generating' || layer.generation?.jobId !== job.jobId) {
    return null;
  }
  return layer;
}

/** 结果落地（下载产物 → 裁边 → 转存 CDN）偶发网络超时：退避重试几次再判失败。 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  times: number,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
