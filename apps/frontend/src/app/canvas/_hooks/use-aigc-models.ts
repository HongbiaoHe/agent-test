"use client";

import { useQuery } from "@tanstack/react-query";

import {
  listAigcModels,
  type AigcCatalog,
  type AigcModel,
  type AigcModelParam,
} from "@/lib/api";

/**
 * 模型目录缓存时长：后台改模型清单不频繁，一次会话里拉一次就够。
 * 与后端 AigcService 的目录缓存（5 分钟）同一量级。
 */
const STALE_MS = 5 * 60_000;

/**
 * 某类型（image / video）的可选模型目录。
 *
 * 清单与档位取值全部来自服务端（它再转发 aigc 的 GET /channels）——前端不硬编码模型名，
 * 也不自己算默认值：`catalog.default` 就是「没选过时实际会用的那份」，直接拿来显示。
 */
export function useAigcModels(type: "image" | "video") {
  return useQuery<AigcCatalog>({
    queryKey: ["aigc-models", type],
    queryFn: () => listAigcModels(type),
    staleTime: STALE_MS,
  });
}

/** 在目录里按 (channel, alias) 找模型。 */
export function findAigcModel(
  catalog: AigcCatalog | undefined,
  channel: string | null,
  alias: string | null,
): AigcModel | null {
  if (!catalog || !channel || !alias) return null;
  const ch = catalog.channels.find((c) => c.channel === channel);
  return ch?.models.find((m) => m.model_alias === alias) ?? null;
}

/**
 * 这个模型上用户真能选的维度：derived 是服务端按参考图推导的（不是入参），
 * range 是连续区间（当前只出现在音频维度，画布用不到）——两者都不渲染。
 */
export function selectableParams(model: AigcModel): AigcModelParam[] {
  return model.params.filter(
    (p) =>
      p.input !== "derived" && p.value_type !== "range" && p.options.length > 0,
  );
}

