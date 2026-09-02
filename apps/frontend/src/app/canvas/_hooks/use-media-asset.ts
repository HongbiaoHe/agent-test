"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchMediaAssetBlob } from "@/lib/api";

/** 资产拉取的三种结局：在途 / 拿到 blob URL / 失败（可重试）。 */
export type MediaAsset =
  | { status: "loading"; url: null; mime: null }
  | { status: "ready"; url: string; mime: string }
  | { status: "error"; url: null; mime: null };

const LOADING: MediaAsset = { status: "loading", url: null, mime: null };
const FAILED: MediaAsset = { status: "error", url: null, mime: null };

/**
 * 取媒体资产的 blob object URL（资产接口带鉴权，不能直接把 URL 塞进 src）。
 * versionId 为空时不发请求。卸载/换 id 时 revoke，避免泄漏。
 *
 * 结果连同来源 versionId 一起存：只有匹配当前 versionId 才返回，
 * 于是换 id 的那一帧不会漏出上一个资产，也不必在 effect 里同步 setState
 * （react-hooks/set-state-in-effect 是 error 级）。
 *
 * ⚠️ 失败必须显式表达：早先的实现 catch 后什么都不做，资产 404/400（文件被清掉、
 * 版本还没落盘）时卡片会永远停在转圈上——用户看不出是"在拉"还是"拉不到"。
 * 现在失败会落到 status:"error"，由调用方渲染重试入口（retry 重新计数即可重发）。
 */
export function useMediaAsset(
  versionId: string | null,
): MediaAsset & { retry: () => void } {
  const [state, setState] = useState<{ id: string; asset: MediaAsset } | null>(
    null,
  );
  // 手动重试：计数变化即重跑 effect（同一 versionId 也能再发一次）
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!versionId) return;
    let revoked: string | null = null;
    let alive = true;
    void fetchMediaAssetBlob(versionId)
      .then((blob) => {
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        revoked = url;
        setState({
          id: versionId,
          // mime 留着给「下载」拼扩展名——blob 本身不带文件名
          asset: { status: "ready", url, mime: blob.type },
        });
      })
      .catch(() => {
        if (!alive) return;
        setState({ id: versionId, asset: FAILED });
      });
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [versionId, attempt]);

  const retry = useCallback(() => {
    setState(null);
    setAttempt((n) => n + 1);
  }, []);

  const asset = state && state.id === versionId ? state.asset : LOADING;
  // 逐分支返回而不是展开联合：展开会把判别式并成 union，调用方 status 判定后拿不到收窄的 url
  if (asset.status === "ready")
    return { status: "ready", url: asset.url, mime: asset.mime, retry };
  if (asset.status === "error")
    return { status: "error", url: null, mime: null, retry };
  return { status: "loading", url: null, mime: null, retry };
}
