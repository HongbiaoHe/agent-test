/**
 * 附件：发送时把用户选的本地文件**复制**进 `<会话运行目录>/attachments/`，消息里只记副本路径。
 * 这样原文件被移动 / 删除不影响之后每一轮的历史重放；运行目录经只读路由挂给 agent（见
 * workspace/workspace-backend.ts），文件工具读得到，也不会往用户自选的工作区里塞文件。
 */
import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import type { AttachmentRef } from '../../shared/rpc';
import { hostI18n } from '../i18n';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export class AttachmentError extends Error {}

export async function copyAttachments(
  dir: string,
  sources: string[],
): Promise<AttachmentRef[]> {
  if (sources.length === 0) return [];
  await mkdir(dir, { recursive: true });
  const out: AttachmentRef[] = [];
  for (const src of sources) {
    let size: number;
    try {
      const st = await stat(src);
      if (!st.isFile()) throw new AttachmentError(hostI18n.t('errors.attachments.notFile', { path: src }));
      size = st.size;
    } catch (e) {
      if (e instanceof AttachmentError) throw e;
      throw new AttachmentError(hostI18n.t('errors.attachments.readFailed', { path: src }));
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(hostI18n.t('errors.attachments.tooLarge', { name: basename(src) }));
    }
    const dest = await uniquePath(dir, basename(src));
    await copyFile(src, dest);
    out.push({ filename: basename(dest), path: dest, size });
  }
  return out;
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}

const userContentSchema = z.object({
  text: z.string().default(''),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        path: z.string(),
        size: z.number(),
        versionId: z.string().optional(),
        mediaType: z.string().optional(),
      }),
    )
    .default([]),
});

export type UserContent = z.infer<typeof userContentSchema>;

export function parseUserContent(content: unknown): UserContent {
  const parsed = userContentSchema.safeParse(content);
  return parsed.success ? parsed.data : { text: '', attachments: [] };
}

/** 重放给模型的用户消息文本：正文 + 「[附件]」清单；副本已不在的标「已丢失」 */
export async function userTextForModel(content: unknown): Promise<string> {
  const { text, attachments } = parseUserContent(content);
  if (attachments.length === 0) return text;
  const lines: string[] = [];
  for (const a of attachments) {
    const exists = await access(a.path).then(
      () => true,
      () => false,
    );
    // 上传成生成素材的附件带 versionId（同 Web「[附件]」口径：类型、versionId、文件名），可被 referenceVersionIds 引用
    const asset = a.versionId ? `，${a.mediaType ?? 'media'}，versionId=${a.versionId}` : '';
    lines.push(
      exists
        ? `- ${a.filename}（${a.path}${asset}）`
        : `- ${a.filename}（附件已丢失：保存的副本被删除，无法读取${asset}）`,
    );
  }
  return `${text}${text ? '\n\n' : ''}[附件]\n${lines.join('\n')}`;
}
