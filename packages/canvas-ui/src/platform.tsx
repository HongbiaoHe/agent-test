"use client";

import type { AigcCatalog } from "@agent-test/canvas-schema";
import { createContext, useContext, type ReactNode } from "react";

/** 画布界面支持的语言（各自一份字典，见 i18n/messages.ts）。 */
export type CanvasLocale = "en" | "zh-CN" | "zh-Hant";

/** 上传的进度回调与中止信号（与 web 的 UploadOptions 同形，desktop 照此实现）。 */
export interface CanvasUploadOptions {
  /** 0 → 1 的上传进度 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * 画布界面对宿主（web / desktop）的全部依赖——包内不 import 任何应用侧代码（API 客户端、路由、主题、socket）。
 * 画布结构的读写（快照、op、生成…）走 FlowCanvas 的 props / 回调；这里只放卡片自己要主动取的东西。
 */
export interface CanvasPlatform {
  /** 界面语言：决定包内字典（按钮、提示、aria-label、toast）用哪一份 */
  locale: CanvasLocale;
  /**
   * 取某个媒体版本（MediaVersion.id）的二进制，卡片用它生成 blob URL 显示图 / 视频 / 音频。
   * 失败请 reject（卡片会显示「Preview failed — retry」）。
   */
  fetchMediaAssetBlob(versionId: string): Promise<Blob>;
  /**
   * 某类生成节点的可选模型目录（GET /aigc/models?type= 的返回形状）。
   * 包内经 react-query 缓存（queryKey ["aigc-models", type]，5 分钟），宿主须在外层挂 QueryClientProvider。
   */
  listAigcModels(type: "image" | "video"): Promise<AigcCatalog>;
}

const CanvasPlatformContext = createContext<CanvasPlatform | null>(null);

/** 宿主在 FlowCanvas 外层挂一次。value 请保持引用稳定（useMemo / 模块常量）。 */
export function CanvasPlatformProvider({
  value,
  children,
}: {
  value: CanvasPlatform;
  children: ReactNode;
}) {
  return (
    <CanvasPlatformContext.Provider value={value}>
      {children}
    </CanvasPlatformContext.Provider>
  );
}

export function useCanvasPlatform(): CanvasPlatform {
  const platform = useContext(CanvasPlatformContext);
  if (!platform) {
    throw new Error(
      "@agent-test/canvas-ui: wrap the canvas in <CanvasPlatformProvider>",
    );
  }
  return platform;
}
