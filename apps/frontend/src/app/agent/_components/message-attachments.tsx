"use client";

import { Music } from "lucide-react";

import type { MessageAttachment } from "@/lib/api";

/**
 * 用户消息气泡上方的附件：图片缩略图、视频 / 音频带原生播放控件。
 * 资源直接取 CDN 地址（aigc 上传后的公开访问地址）。
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      aria-label="Attachments"
      className="flex max-w-[80%] flex-wrap justify-end gap-2"
    >
      {attachments.map((a) => (
        <li key={a.versionId}>
          {a.type === "image" ? (
            <a href={a.url} target="_blank" rel="noreferrer" title={a.filename}>
              {/* CDN 资源原样展示：尺寸未知、无需 next/image 优化 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.url}
                alt={a.filename}
                className="h-32 max-w-60 rounded-xl border bg-muted object-cover"
              />
            </a>
          ) : a.type === "video" ? (
            <video
              src={a.url}
              controls
              preload="metadata"
              title={a.filename}
              className="h-32 max-w-60 rounded-xl border bg-muted"
            />
          ) : (
            <div className="flex w-64 flex-col gap-1.5 rounded-xl border bg-card p-2">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Music className="size-3.5 shrink-0" />
                <span className="truncate">{a.filename}</span>
              </span>
              <audio src={a.url} controls preload="none" className="h-8 w-full" />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
