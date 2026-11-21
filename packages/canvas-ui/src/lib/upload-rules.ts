import type { CanvasIoType } from "@agent-test/canvas-schema";

import type { CanvasMessages } from "../i18n/messages";

const MB = 1024 * 1024;

/**
 * 上传节点可收的文件类型 = aigc 上传白名单（后端 media-upload.service 的 UPLOAD_CONTENT_TYPES；
 * web 的对话附件 components/attachments/attachments.ts 也是同一张表，改动需三处同步）。
 * 浏览器给不出 MIME、或给的不在表里（gif / webm / pdf …）一律不收。
 */
export const UPLOAD_CONTENT_TYPES: Record<string, CanvasIoType> = {
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
export const UPLOAD_MAX_BYTES: Record<CanvasIoType, number> = {
  image: 20 * MB,
  video: 200 * MB,
  audio: 50 * MB,
};

/** 选进来的文件能不能传：能 → 资产类型；不能 → 给用户看的原因（当前语言）。 */
export function classifyUpload(
  file: File,
  t: CanvasMessages,
): { ok: true; type: CanvasIoType } | { ok: false; reason: string } {
  const type = UPLOAD_CONTENT_TYPES[file.type];
  if (!type) return { ok: false, reason: t.upload.unsupported(file.name) };
  if (file.size > UPLOAD_MAX_BYTES[type]) {
    return {
      ok: false,
      reason: t.upload.tooLarge(file.name, UPLOAD_MAX_BYTES[type] / MB, t.ioType[type]),
    };
  }
  return { ok: true, type };
}
