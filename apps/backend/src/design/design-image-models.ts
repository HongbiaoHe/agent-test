import {
  BYTEPLUS_CHANNEL,
  DEFAULT_IMAGE_RESOLUTION,
  GPT_IMAGE_MODEL_PREFIX,
  type ImageModelChoice,
  PREFERRED_IMAGE_MODEL,
  SEEDREAM_MODEL,
  SEEDREAM_RESOLUTIONS,
} from '@agent-test/design-schema';
import type { AigcCatalog, AigcCatalogModel } from '../aigc/aigc.types';

/** 前端下拉与 agent 都用这一份：只含支持透明背景的模型（问题 16）。 */
export interface DesignImageModel {
  channel: string;
  model: string;
  label: string;
  /** 画质档位（目录 resolution 维度的取值） */
  resolutions: { value: string; label: string }[];
  /** 画幅（目录 aspect_ratio 维度的取值，如 1x1 / 4x5） */
  aspectRatios: string[];
  maxReferenceImages: number;
}

function optionsOf(m: AigcCatalogModel, dim: string) {
  return m.params.find((p) => p.param_type === dim)?.options ?? [];
}

/** Seedream 5.0 Pro（直连 BytePlus）：图生图最多 10 张参考图，画幅按图层框比例直接传像素宽高。 */
export const SEEDREAM_IMAGE_MODEL: DesignImageModel = {
  channel: BYTEPLUS_CHANNEL,
  model: SEEDREAM_MODEL,
  label: 'Seedream 5.0 Pro',
  resolutions: SEEDREAM_RESOLUTIONS.map((r) => ({ ...r })),
  aspectRatios: [],
  maxReferenceImages: 10,
};

/**
 * 单图层下拉只放两家：aigc 目录里支持透明背景的 gpt-image-2.5（含其变体），
 * 加上配了 BytePlus key 时的 Seedream 5.0 Pro。
 */
export function designImageModels(
  catalog: AigcCatalog | null,
  seedream: boolean,
): DesignImageModel[] {
  return [
    ...(catalog ? transparentImageModels(catalog) : []).filter((m) =>
      m.model.startsWith(GPT_IMAGE_MODEL_PREFIX),
    ),
    ...(seedream ? [SEEDREAM_IMAGE_MODEL] : []),
  ];
}

/** 从 aigc 目录推导：params 里有 background 维度且取值含 transparent 的模型才算。 */
function transparentImageModels(catalog: AigcCatalog): DesignImageModel[] {
  const out: DesignImageModel[] = [];
  for (const ch of catalog.channels) {
    for (const m of ch.models) {
      const bg = optionsOf(m, 'background');
      if (!bg.some((o) => o.value === 'transparent')) continue;
      out.push({
        channel: ch.channel,
        model: m.model_alias,
        label: m.display_name ?? m.model_alias,
        resolutions: optionsOf(m, 'resolution').map((o) => ({
          value: o.value,
          label: o.label,
        })),
        aspectRatios: optionsOf(m, 'aspect_ratio').map((o) => o.value),
        maxReferenceImages: m.image_input_number,
      });
    }
  }
  // 首选模型排第一（下拉默认项）
  return out.sort(
    (a, b) =>
      Number(b.model === PREFERRED_IMAGE_MODEL) -
      Number(a.model === PREFERRED_IMAGE_MODEL),
  );
}

/** 会话里存的选择 → 目录里真实存在的模型；选择已失效（模型下线）就回落首选。 */
export function resolveImageModel(
  models: DesignImageModel[],
  choice: ImageModelChoice | null | undefined,
): { model: DesignImageModel; resolution: string } | null {
  const found =
    (choice &&
      models.find(
        (m) => m.channel === choice.channel && m.model === choice.model,
      )) ||
    models[0];
  if (!found) return null;
  const wanted = choice?.resolution ?? DEFAULT_IMAGE_RESOLUTION;
  const resolution = found.resolutions.some((r) => r.value === wanted)
    ? wanted
    : (found.resolutions.find((r) => r.value === DEFAULT_IMAGE_RESOLUTION)
        ?.value ??
      found.resolutions[0]?.value ??
      DEFAULT_IMAGE_RESOLUTION);
  return { model: found, resolution };
}
