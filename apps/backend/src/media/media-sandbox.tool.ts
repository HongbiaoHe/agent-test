import { tool } from '@langchain/core/tools';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import { mediaDataDir, MediaService } from './media.service';
import type { MediaToolContext } from './media.tools';

/** 写文件用 uploadFiles、路径以 visibleRoot（/workspace）为根（测试时可注入假实现）。 */
export type MediaSandbox = Pick<GuardedSandbox, 'uploadFiles' | 'visibleRoot'>;

/** 一次最多同步几个：同一条消息的附件上限也是 10。 */
const SYNC_MAX = 10;

/** 从 CDN 拉一个资产的硬超时：最大的视频 200MB，给足余量。 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

const schema = z.object({
  versionIds: z
    .array(z.string())
    .min(1)
    .max(SYNC_MAX)
    .describe(
      '要同步进沙箱的媒体 versionId（用户上传的附件或本会话生成的图片 / 视频，取自「[附件]」或资产清单）',
    ),
});

/**
 * 按需把本会话的媒体（用户上传的附件、aigc 生成的图片 / 视频）同步进沙箱工作区。
 *
 * 为什么由后端搬运而不是让模型在沙箱里 curl：沙箱出站可被设成 allowlist，CDN 不一定放行；
 * 后端从 CDN（或本地拼接产物文件）读出字节，经 uploadFiles 直接写进沙箱盘，不依赖沙箱网络。
 * 落在 `<workspace>/media/<versionId>/<文件名>`：按 versionId 分目录，同名文件互不覆盖；
 * 重复同步同一版本会覆盖成同样的内容（资产不可变），无副作用。
 * 只在有沙箱时挂载（同 preview_page）。
 */
export function createSyncMediaTool(
  svc: MediaService,
  sb: MediaSandbox,
  ctx: MediaToolContext,
) {
  return tool(
    async ({ versionIds }: z.infer<typeof schema>) => {
      const unique = [...new Set(versionIds)];
      const { sources, errors } = await svc.resolveSandboxSources(
        ctx.conversationId,
        ctx.userId,
        unique,
      );
      const synced: { versionId: string; type: string; path: string }[] = [];
      for (const src of sources) {
        const path = `${sb.visibleRoot}/media/${src.versionId}/${safeName(src.filename)}`;
        try {
          const bytes = src.url
            ? await fetchBytes(src.url)
            : await readFile(join(mediaDataDir(), src.filePath ?? ''));
          const [result] = await sb.uploadFiles([[path, bytes]]);
          if (result?.error) throw new Error(String(result.error));
          synced.push({ versionId: src.versionId, type: src.type, path });
        } catch (e) {
          errors.push({
            versionId: src.versionId,
            reason: `同步失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      return JSON.stringify({ synced, ...(errors.length ? { errors } : {}) });
    },
    {
      name: 'sync_media_to_sandbox',
      description:
        '把本会话的媒体文件（用户上传的附件、生成的图片 / 视频）同步进沙箱工作区，返回沙箱内路径。' +
        '只有需要用命令处理文件本身时才调用（如 ffmpeg 剪辑 / 转码、Python 处理图片、读取音频）；' +
        '仅作为生成参考时不需要同步，直接用 referenceVersionIds 引用即可。同一文件同步一次即可，之后直接用返回的路径。',
      schema,
    },
  );
}

/** 文件名只留常见安全字符（中日韩文字保留），其余换成 _：命令行里不用转义也不会被拆开。 */
function safeName(filename: string): string {
  const cleaned = filename.replace(/[^\w.\-぀-ヿ一-鿿]/g, '_');
  return cleaned.replace(/^\.+/, '_') || 'file';
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`下载资产失败 HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
