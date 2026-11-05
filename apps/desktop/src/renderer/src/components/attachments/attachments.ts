import type { AttachmentType, MessageAttachment } from "@/lib/api";

/**
 * 桌面端附件：用户选的本地文件，发送时由 agent-host 复制进会话运行目录（见 agent-host/run/attachments.ts）。
 * 与 Web 不同，不限类型（agent 用 read_file / execute 处理），单文件上限同 agent-host 的 50MB。
 */
export const ATTACHMENTS_MAX = 10;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);

export function attachmentTypeOf(filename: string): AttachmentType {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

/** message.content.attachments（agent-host 落库的 AttachmentRef[]）逐项收窄；形状不对的丢掉 */
export function parseAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  // Array.isArray 把 unknown 收窄成 any[]；先落回 unknown[] 再逐项守卫
  const list: unknown[] = value;
  const out: MessageAttachment[] = [];
  for (const v of list) {
    if (typeof v !== "object" || v === null) continue;
    if (!("filename" in v) || typeof v.filename !== "string") continue;
    if (!("path" in v) || typeof v.path !== "string") continue;
    const size = "size" in v && typeof v.size === "number" ? v.size : 0;
    out.push({ filename: v.filename, path: v.path, size, type: attachmentTypeOf(v.filename) });
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
