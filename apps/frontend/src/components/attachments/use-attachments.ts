"use client";

import { useState } from "react";
import { toast } from "sonner";

import type {
  AttachmentType,
  MessageAttachment,
  UploadedAttachment,
  UploadOptions,
} from "@/lib/api";

import { ATTACHMENTS_MAX, classifyFile } from "./attachments";

/** 输入框里的一枚附件：选中即开始上传，传完拿到 asset（versionId 等）才能随消息发出。 */
export interface DraftAttachment {
  localId: string;
  file: File;
  type: AttachmentType;
  /** 本地预览地址（object URL）：图片 / 视频缩略图用，移除或发送后回收 */
  previewUrl: string;
  status: "uploading" | "done" | "error";
  /** 0–1 */
  progress: number;
  asset?: MessageAttachment;
  error?: string;
  /** 中止本枚上传（移除 / 切会话时） */
  controller: AbortController;
}

/**
 * 输入框附件的状态：加文件 → 校验（类型 / 大小 / 数量）→ 立刻上传（带进度）→ 可移除。
 * 会话切换时清空（render 期校正，不在 effect 里 setState）。
 * 发送条件：没有在传的、且至少有正文或一个传好的附件——上传中禁用发送（设计已定，不做后台补传）。
 *
 * upload：往哪传由调用方定（Spark 会话 / 画布对话各有各的上传接口），这里只管状态。
 */
export function useAttachments(
  conversationId: string | null,
  upload: (
    conversationId: string,
    file: File,
    opts: UploadOptions,
  ) => Promise<UploadedAttachment>,
) {
  const [items, setItems] = useState<DraftAttachment[]>([]);

  const [trackedId, setTrackedId] = useState(conversationId);
  if (trackedId !== conversationId) {
    setTrackedId(conversationId);
    // 切走的会话里还在传的就不要了；预览地址一并回收
    for (const it of items) {
      it.controller.abort();
      URL.revokeObjectURL(it.previewUrl);
    }
    setItems([]);
  }

  function patch(localId: string, next: Partial<DraftAttachment>) {
    setItems((prev) =>
      prev.map((it) => (it.localId === localId ? { ...it, ...next } : it)),
    );
  }

  function add(files: FileList | File[]) {
    if (!conversationId) return;
    const room = ATTACHMENTS_MAX - items.length;
    const list = Array.from(files);
    if (list.length > room) {
      toast.error(`At most ${ATTACHMENTS_MAX} attachments per message`);
    }
    const added: DraftAttachment[] = [];
    for (const file of list.slice(0, Math.max(room, 0))) {
      const checked = classifyFile(file);
      if (!checked.ok) {
        toast.error(checked.reason);
        continue;
      }
      added.push({
        localId: crypto.randomUUID(),
        file,
        type: checked.type,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        progress: 0,
        controller: new AbortController(),
      });
    }
    if (added.length === 0) return;
    setItems((prev) => [...prev, ...added]);

    for (const it of added) {
      const { controller } = it;
      upload(conversationId, it.file, {
        signal: controller.signal,
        onProgress: (progress) => patch(it.localId, { progress }),
      })
        .then((asset) => patch(it.localId, { status: "done", progress: 1, asset }))
        .catch((e: unknown) => {
          // 用户移除 / 切会话主动中止的不算失败
          if (controller.signal.aborted) return;
          patch(it.localId, {
            status: "error",
            error: e instanceof Error ? e.message : "Upload failed",
          });
        });
    }
  }

  function remove(localId: string) {
    const target = items.find((it) => it.localId === localId);
    if (!target) return;
    target.controller.abort();
    URL.revokeObjectURL(target.previewUrl);
    setItems((prev) => prev.filter((it) => it.localId !== localId));
  }

  /** 发送后清空：附件已随消息发出，预览地址回收（气泡改用 CDN 地址展示）。 */
  function clear() {
    for (const it of items) URL.revokeObjectURL(it.previewUrl);
    setItems([]);
  }

  const uploading = items.some((it) => it.status === "uploading");
  const ready = items.flatMap((it) => (it.asset ? [it.asset] : []));

  return { items, add, remove, clear, uploading, ready };
}
