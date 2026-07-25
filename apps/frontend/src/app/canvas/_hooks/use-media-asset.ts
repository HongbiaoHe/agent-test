"use client";

import { useEffect, useState } from "react";

import { fetchMediaAssetBlob } from "@/lib/api";

/**
 * 取媒体资产的 blob object URL（资产接口带鉴权，不能直接把 URL 塞进 src）。
 * versionId 为空时不发请求。卸载/换 id 时 revoke，避免泄漏。
 *
 * 结果连同来源 versionId 一起存：只有匹配当前 versionId 才返回，
 * 于是换 id 的那一帧不会漏出上一个资产，也不必在 effect 里同步 setState
 * （react-hooks/set-state-in-effect 是 error 级）。
 */
export function useMediaAssetUrl(versionId: string | null): string | null {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    if (!versionId) return;
    let revoked: string | null = null;
    let alive = true;
    void fetchMediaAssetBlob(versionId)
      .then((blob) => {
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        revoked = url;
        setLoaded({ id: versionId, url });
      })
      .catch(() => void 0);
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [versionId]);

  return loaded && loaded.id === versionId ? loaded.url : null;
}
