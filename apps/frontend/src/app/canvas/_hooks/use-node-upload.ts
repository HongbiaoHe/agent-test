"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  ATTACHMENT_CONTENT_TYPES,
  classifyFile,
} from "@/components/attachments/attachments";
import type { CanvasUploadNodeType, UploadOptions } from "@/lib/api";

import { UPLOAD_NODE_ASSET } from "../_lib/node-io";

/**
 * 卡片自己的上传进度。传完进 settled：接口已返回，但节点数据要等 socket patch / 快照重拉
 * 才换成新版本——这段空窗里卡片仍按「上传中」显示（见 isUploading），不闪回空态。
 */
export type NodeUploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number }
  | { status: "settled"; versionId: string }
  | { status: "error"; message: string; file: File };

/**
 * 上传节点卡片的上传状态：选 / 拖进来一个文件 → 校验（白名单、大小、与节点类型一致）→ 上传（带进度）。
 * 失败留着那个文件，「重试」原样再传一次。往哪传由调用方给（画布编辑上下文的 uploadNodeFile）。
 */
export function useNodeUpload(
  nodeId: string,
  nodeType: CanvasUploadNodeType,
  /** 节点此刻挂着的版本（快照 / patch 里的 mediaVersionId） */
  currentVersionId: string | null,
  upload: (
    nodeId: string,
    file: File,
    opts: UploadOptions,
  ) => Promise<{ versionId: string }>,
) {
  const [state, setState] = useState<NodeUploadState>({ status: "idle" });
  const asset = UPLOAD_NODE_ASSET[nodeType];
  // 文件选择框只列这个节点收的那类（白名单的子集）
  const accept = Object.entries(ATTACHMENT_CONTENT_TYPES)
    .filter(([, t]) => t === asset)
    .map(([mime]) => mime)
    .join(",");

  function start(file: File) {
    const checked = classifyFile(file);
    if (!checked.ok) {
      toast.error(checked.reason);
      return;
    }
    if (checked.type !== asset) {
      toast.error(`${file.name}: this node takes ${asset} files`);
      return;
    }
    setState({ status: "uploading", progress: 0 });
    upload(nodeId, file, {
      onProgress: (progress) => setState({ status: "uploading", progress }),
    })
      .then(({ versionId }) => setState({ status: "settled", versionId }))
      .catch((e: unknown) =>
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "Upload failed",
          file,
        }),
      );
  }

  function retry() {
    if (state.status === "error") start(state.file);
  }

  const isUploading =
    state.status === "uploading" ||
    (state.status === "settled" && currentVersionId !== state.versionId);

  return { state, isUploading, accept, start, retry };
}
