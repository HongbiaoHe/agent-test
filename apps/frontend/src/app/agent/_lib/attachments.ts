import type { AttachmentType } from "@/lib/api";

const MB = 1024 * 1024;

/**
 * 可上传类型 = aigc 上传白名单（后端 media-upload.service 的 UPLOAD_CONTENT_TYPES，改动需两边同步）。
 * 浏览器给不出 MIME、或给的不在表里（gif / webm / pdf …）一律不收。
 */
export const ATTACHMENT_CONTENT_TYPES: Record<string, AttachmentType> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/mp4": "audio",
  "audio/x-m4a": "audio",
};

/** 单文件上限（同后端 UPLOAD_MAX_BYTES）。 */
export const ATTACHMENT_MAX_BYTES: Record<AttachmentType, number> = {
  image: 20 * MB,
  video: 200 * MB,
  audio: 50 * MB,
};

/** 一条消息最多带几个附件（同后端 ATTACHMENTS_MAX）。 */
export const ATTACHMENTS_MAX = 10;

/** 文件选择框的 accept：就是白名单本身。 */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_CONTENT_TYPES).join(",");

/** 选进来的文件能不能传：能 → 资产类型；不能 → 给用户看的原因。 */
export function classifyFile(
  file: File,
): { ok: true; type: AttachmentType } | { ok: false; reason: string } {
  const type = ATTACHMENT_CONTENT_TYPES[file.type];
  if (!type) {
    return {
      ok: false,
      reason: `${file.name}: unsupported format (images: JPEG/PNG/WebP, videos: MP4/MOV, audio: MP3/WAV/M4A)`,
    };
  }
  if (file.size > ATTACHMENT_MAX_BYTES[type]) {
    return {
      ok: false,
      reason: `${file.name}: too large (max ${ATTACHMENT_MAX_BYTES[type] / MB}MB for ${type})`,
    };
  }
  return { ok: true, type };
}
