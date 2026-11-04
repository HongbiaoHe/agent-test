import type {
  DesignCanvas,
  DesignDocument,
  DesignModel,
  DesignOp,
  ImageModelChoice,
} from "@agent-test/design-schema";

import { request, type UploadOptions, uploadFile } from "@/lib/api";

/** 设计模块的 REST 客户端（后端 apps/backend/src/design/design.controller.ts）。 */

export interface DesignSnapshot {
  id: string;
  title: string;
  status: DesignRunStatus;
  model: DesignModel | null;
  imageModel: ImageModelChoice | null;
  revision: number;
  document: DesignDocument;
  updatedAt: string;
}

export type DesignRunStatus = "idle" | "running" | "done" | "failed" | "stopped";

export interface DesignListItem {
  id: string;
  title: string;
  status: DesignRunStatus;
  revision: number;
  canvas: DesignCanvas;
  layerCount: number;
  updatedAt: string;
}

export interface DesignImageModel {
  channel: string;
  model: string;
  label: string;
  resolutions: { value: string; label: string }[];
  aspectRatios: string[];
  maxReferenceImages: number;
}

export interface StoredImage {
  url: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  filename: string;
}

export interface DesignAttachment {
  url: string;
  filename: string;
  width: number;
  height: number;
}

export interface DesignUserMessage {
  text: string;
  attachments: DesignAttachment[];
  selection: string[];
  splitLayerId?: string;
}

export interface DesignMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  type: string;
  content: unknown;
  seq: number;
  createdAt: string;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3101";

export const designApi = {
  list: () => request<DesignListItem[]>("/design"),
  create: (input: { title?: string; canvas?: DesignCanvas }) =>
    request<DesignSnapshot>("/design", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  get: (id: string) => request<DesignSnapshot>(`/design/${id}`),
  updateMeta: (
    id: string,
    patch: { title?: string; model?: DesignModel; imageModel?: ImageModelChoice },
  ) =>
    request<DesignSnapshot>(`/design/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<{ ok: true }>(`/design/${id}`, { method: "DELETE" }),
  applyOps: (id: string, ops: DesignOp[], clientId: string) =>
    request<{ revision: number }>(`/design/${id}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops, clientId }),
    }),
  generate: (
    id: string,
    layerId: string,
    body: { prompt: string; referenceUrls?: string[]; useCurrentAsReference?: boolean },
  ) =>
    request<{ jobId: string }>(`/design/${id}/layers/${layerId}/generate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** 拆层（Seedream）：失败图层点「重试」时用；正常拆分由 agent 发起 */
  decompose: (id: string, layerId: string, body: { prompt?: string } = {}) =>
    request<{ jobId: string }>(`/design/${id}/layers/${layerId}/decompose`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  imageModels: () => request<DesignImageModel[]>("/design/image-models"),
  messages: (id: string) => request<DesignMessageRow[]>(`/design/${id}/messages`),
  send: (id: string, message: DesignUserMessage, model?: DesignModel) =>
    request<{ ok: true }>(`/design/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message, model }),
    }),
  stop: (id: string) =>
    request<{ stopped: boolean }>(`/design/${id}/stop`, { method: "POST" }),
  upload: (id: string, file: File, opts: UploadOptions = {}) =>
    uploadFile<StoredImage>(`/api/design/${encodeURIComponent(id)}/uploads`, file, opts),
  /** 列表缩略图（后端同构渲染）；带 revision 让浏览器缓存随改动失效 */
  thumbnailUrl: (id: string, revision: number) =>
    `${API_BASE}/design/${id}/thumbnail.png?r=${revision}`,
};
