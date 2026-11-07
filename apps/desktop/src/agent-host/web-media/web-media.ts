/**
 * 桌面端的 aigc 能力：工具定义与 Web 共用 agent-core media-tools（list_media_models / generate_image /
 * generate_video / generate_audio / clone_voice），这里把「怎么生成」接到 Web 后端的 /media-api 接口——
 * 后端调的是 Web 同一个 MediaService（模型目录、参数校验、接单、回调对账、CDN 产物全部一致）。
 * 生成记录在后端按 `desktop:<本机会话 id>` 记账；卡片状态由 renderer 轮询 media.list。
 *
 * 另有两件桌面端自己的事：
 * - sync_media_to_sandbox：同 Web 的同名工具，把本会话媒体下载进**本机工作区**（Web 是写进沙箱）；
 * - 附件上传：用户随消息发的图片 / 视频 / 音频上传到 Web 账号，拿到 versionId 才能被 referenceVersionIds 引用。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  createMediaTools,
  type MediaCloneOutcome,
  type MediaGenerateOutcome,
  type MediaToolBackend,
} from '@agent-test/agent-core/media/media-tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { WebApi, WebApiError } from './web-api';

export const SYNC_MEDIA_TOOL = 'sync_media_to_sandbox';
const SYNC_MAX = 10;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const issue = z.object({ field: z.string(), message: z.string(), value: z.string().optional() }).loose();
const config = z.object({
  model: z.string(),
  channel: z.string(),
  params: z.record(z.string(), z.string()),
});
const genRef = z.object({ generationId: z.string(), versionId: z.string() });
const generateOutcome = z.union([
  z.object({ ok: z.literal(false), issues: z.array(issue) }),
  z.object({ ok: z.literal(true), config, generations: z.array(genRef) }),
]);
const cloneOutcome = z.union([
  z.object({ ok: z.literal(false), issues: z.array(issue) }),
  z.object({ ok: z.literal(true), config, generation: genRef }),
]);

/** 同 Web 工具的 BusinessException 分支：可改正的业务错误回给模型（含登录过期，让模型提示用户重新登录） */
function userError(e: unknown): unknown {
  if (!(e instanceof WebApiError)) return null;
  if (e.unauthorized) return { code: 'unauthorized', message: e.message };
  if (e.status >= 400 && e.status < 500) return { code: e.code, message: e.message };
  return null;
}

export function webMediaBackend(api: WebApi, conversationId: string): MediaToolBackend {
  return {
    listModels: (type) => api.get(`/media-api/models?type=${type}`),
    generate: async (type, input): Promise<MediaGenerateOutcome> =>
      generateOutcome.parse(await api.post('/media-api/generations', { scope: conversationId, type, ...input })),
    cloneVoice: async (input): Promise<MediaCloneOutcome> =>
      cloneOutcome.parse(await api.post('/media-api/voices', { scope: conversationId, ...input })),
    userError,
  };
}

/** 生图 / 生视频 / 配音 / 克隆音色五个工具（与 Web 同一份定义） */
export function createWebMediaTools(api: WebApi, conversationId: string) {
  return createMediaTools(webMediaBackend(api, conversationId));
}

const sourcesSchema = z.object({
  sources: z.array(
    z.object({
      versionId: z.string(),
      type: z.string(),
      filename: z.string(),
      url: z.string().nullable(),
    }),
  ),
  errors: z.array(z.object({ versionId: z.string(), reason: z.string() })),
});

/** 文件名只留常见安全字符（中日韩文字保留），其余换成 _（同 Web media-sandbox.tool safeName） */
function safeName(filename: string): string {
  const cleaned = filename.replace(/[^\w.\-぀-ヿ一-鿿]/g, '_');
  return cleaned.replace(/^\.+/, '_') || 'file';
}

/** 从 CDN 下载到工作区（同 Web fetchBytes：整块读，最大的视频约 200MB）；先写 .part 再改名，不留半截文件 */
async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
}

export interface SyncedMedia {
  versionId: string;
  type: string;
  /** 工作区内的绝对路径 */
  path: string;
}

export type SyncMediaResult =
  | { error: unknown }
  | { synced: SyncedMedia[]; errors?: { versionId: string; reason: string }[] };

/**
 * 把本会话的媒体（用户附件、生成产物）下载进本机工作区 `<工作区>/media/<versionId>/<文件名>`。
 * 可改正的业务错误（含登录过期）以 `{ error }` 返回，单个版本下载失败记进 errors。
 * sync_media_to_sandbox 与 create_video_project（引用 versionId 的片段）共用。
 */
export async function syncMediaToWorkspace(
  api: WebApi,
  conversationId: string,
  workspaceDir: string,
  versionIds: string[],
): Promise<SyncMediaResult> {
  const unique = [...new Set(versionIds)];
  let resolved: z.infer<typeof sourcesSchema>;
  try {
    resolved = sourcesSchema.parse(await api.post('/media-api/sources', { scope: conversationId, versionIds: unique }));
  } catch (e) {
    const err = userError(e);
    if (err !== null) return { error: err };
    throw e;
  }
  const errors = [...resolved.errors];
  const synced: SyncedMedia[] = [];
  for (const src of resolved.sources) {
    const path = join(workspaceDir, 'media', src.versionId, safeName(src.filename));
    if (!src.url) {
      errors.push({ versionId: src.versionId, reason: '这个版本没有可下载的地址' });
      continue;
    }
    try {
      await download(src.url, path);
      synced.push({ versionId: src.versionId, type: src.type, path });
    } catch (e) {
      errors.push({ versionId: src.versionId, reason: `同步失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { synced, ...(errors.length ? { errors } : {}) };
}

/**
 * 同 Web 的 sync_media_to_sandbox：把本会话的媒体（用户附件、生成产物）下载进本机工作区
 * `<工作区>/media/<versionId>/<文件名>`，返回路径供 execute（ffmpeg 等）使用。只读会话不提供。
 */
export function createSyncMediaTool(api: WebApi, conversationId: string, workspaceDir: string) {
  return tool(
    async ({ versionIds }: { versionIds: string[] }) =>
      JSON.stringify(await syncMediaToWorkspace(api, conversationId, workspaceDir, versionIds)),
    {
      name: SYNC_MEDIA_TOOL,
      description:
        '把本会话的媒体文件（用户上传的附件、生成的图片 / 视频 / 音频）下载进本机工作区，返回工作区内路径。' +
        '只有需要用命令处理文件本身时才调用（如 ffmpeg 剪辑 / 转码、Python 处理图片、读取音频）；' +
        '仅作为生成参考时不需要同步，直接用 referenceVersionIds 引用即可。同一文件同步一次即可，之后直接用返回的路径。',
      schema: z.object({
        versionIds: z
          .array(z.string())
          .min(1)
          .max(SYNC_MAX)
          .describe('要同步进工作区的媒体 versionId（用户上传的附件或本会话生成的媒体，取自「[附件]」或工具结果）'),
      }),
    },
  );
}

/** 可上传为生成素材的附件类型（同 Web 附件白名单 / backend UPLOAD_CONTENT_TYPES） */
const UPLOAD_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const uploadedSchema = z.object({
  versionId: z.string(),
  type: z.string(),
  url: z.string(),
  contentType: z.string(),
});

export type UploadedMedia = z.infer<typeof uploadedSchema>;

/** 附件里的图片 / 视频 / 音频上传到 Web 账号（其余类型不传，返回 null）；失败抛错由调用方决定是否降级 */
export async function uploadAttachment(
  api: WebApi,
  conversationId: string,
  file: string,
  filename: string,
): Promise<UploadedMedia | null> {
  const contentType = UPLOAD_TYPES[extname(filename).toLowerCase()];
  if (!contentType) return null;
  const q = `scope=${encodeURIComponent(conversationId)}&filename=${encodeURIComponent(filename)}`;
  return uploadedSchema.parse(await api.upload(`/media-api/uploads?${q}`, file, contentType));
}
