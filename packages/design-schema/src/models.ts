import { z } from 'zod';

/**
 * 设计 agent 的 LLM 白名单（问题 7）：只放原生多模态的 Gemini——这个 agent 每一步都要看图
 * （参考图、产品图、自己排出来的版面）。独立于主 agent 的 ALLOWED_MODELS 与画布的 CANVAS_MODELS。
 * 裸名（无冒号）即 google-genai provider。
 */
export const DESIGN_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', hint: '默认 · 快且稳' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', hint: '复刻与排版最强' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', hint: '新一代' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', hint: '轻快' },
] as const;

export type DesignModel = (typeof DESIGN_MODELS)[number]['id'];

export const DESIGN_MODEL_IDS = DESIGN_MODELS.map((m) => m.id) as [
  DesignModel,
  ...DesignModel[],
];

export const DEFAULT_DESIGN_MODEL: DesignModel = 'gemini-3.8-flash';

export const designModelSchema = z.enum(DESIGN_MODEL_IDS);

/** 生图模型选择（会话级，问题 16）：只会是目录里支持透明背景的模型，由后端动态推导。 */
export const imageModelChoiceSchema = z.strictObject({
  channel: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  /** 画质档位（目录里的 resolution 维度），默认 medium */
  resolution: z.string().min(1).max(16),
});
export type ImageModelChoice = z.infer<typeof imageModelChoiceSchema>;

export const DEFAULT_IMAGE_RESOLUTION = 'medium';
export const PREFERRED_IMAGE_MODEL = 'gpt-image-2.5-flare';
/** 单图层下拉只放 gpt-image-2.5（aigc 目录里按这个前缀取）与 Seedream 5.0 Pro */
export const GPT_IMAGE_MODEL_PREFIX = 'gpt-image-2.5';

/** 直连 BytePlus ModelArk 的 Seedream 5.0 Pro：channel / model 是我方的逻辑名，真实模型 ID 走环境变量 */
export const BYTEPLUS_CHANNEL = 'byteplus';
export const SEEDREAM_MODEL = 'seedream-5.0-pro';
export const SEEDREAM_RESOLUTIONS = [
  { value: '2K', label: '2K' },
  { value: '1.5K', label: '1.5K' },
  { value: '1K', label: '1K' },
] as const;

/** 单次 agent 运行最多提交多少次生图（问题 10：全自动但防死循环烧钱）。 */
export const MAX_GENERATIONS_PER_RUN = 20;
