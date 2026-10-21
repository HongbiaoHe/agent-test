import { z } from 'zod';

/**
 * 用户消息 content 的形状：`{ text, attachments? }`。attachments 是随这条消息发出的上传附件
 * （见 MediaService.commitAttachments）；老消息只有 text。Json 列读出来用 zod 收窄，不写断言。
 */
const userMessageContentSchema = z.object({
  text: z.string().optional(),
  attachments: z
    .array(
      z.object({
        versionId: z.string(),
        type: z.string(),
        filename: z.string(),
      }),
    )
    .optional(),
});

/**
 * 重放给模型的用户消息文本：正文 + 末尾一段「[附件]」清单（类型 / versionId / 文件名）。
 * 模型据此知道「这一轮用户给了哪些素材」，可直接把 versionId 填进 referenceVersionIds。
 */
export function userMessageText(content: unknown): string {
  const parsed = userMessageContentSchema.safeParse(content);
  if (!parsed.success) return '';
  const text = parsed.data.text ?? '';
  const attachments = parsed.data.attachments ?? [];
  if (attachments.length === 0) return text;
  const lines = attachments.map(
    (a) => `- ${a.type} versionId=${a.versionId} 文件名 ${a.filename}`,
  );
  return `${text}${text ? '\n\n' : ''}[附件]\n${lines.join('\n')}`;
}

/**
 * 用户消息的一行摘要（token 报表里的「本轮目标」）：有正文用正文；只发了附件就列文件名。
 */
export function userMessageSummary(content: unknown): string {
  const parsed = userMessageContentSchema.safeParse(content);
  if (!parsed.success) return '';
  const text = parsed.data.text?.trim() ?? '';
  if (text) return text;
  const names = (parsed.data.attachments ?? []).map((a) => a.filename);
  return names.length ? `[${names.join(', ')}]` : '';
}
