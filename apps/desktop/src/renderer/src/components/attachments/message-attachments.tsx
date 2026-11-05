import { File, FileAudio, FileImage, FileVideo } from "lucide-react";

import type { MessageAttachment } from "@/lib/api";

import { formatBytes } from "./attachments";

const ICON = { image: FileImage, video: FileVideo, audio: FileAudio, file: File } as const;

/**
 * 用户消息气泡上方的附件（桌面端版本）：文件卡片，点开在访达中定位副本。
 * Web 版直接用 CDN 地址内联图片 / 播放器；桌面端副本在本机运行目录，renderer 不直接读本地文件。
 */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex max-w-[80%] flex-wrap justify-end gap-2">
      {attachments.map((a) => {
        const Icon = ICON[a.type];
        return (
          <li key={a.path}>
            <button
              type="button"
              title={a.path}
              onClick={() => void window.desktop.showInFolder(a.path)}
              className="flex max-w-60 items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left text-xs hover:bg-accent"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">{a.filename}</span>
                {/* 刚发出时的本地回显还不知道大小（agent-host 复制后才有），不显示「0 B」 */}
                {a.size > 0 && <span className="block text-muted-foreground">{formatBytes(a.size)}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
