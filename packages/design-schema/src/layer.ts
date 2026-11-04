import { z } from 'zod';
import { FONT_FAMILIES } from './fonts';

/**
 * 图层与文档的数据结构（前端编辑、后端 op 落库、agent 工具三处共用同一份校验）。
 *
 * 坐标一律是**设计稿像素**（与画布 width/height 同一坐标系），不是屏幕像素：
 * 缩放视图只影响显示，不改数据。图层数组顺序即 z 序，越靠后越在上层。
 *
 * 用 strictObject：多余字段直接拒——文字图层带 `src`、图片图层带 `fontSize` 这类「类型串了」的
 * patch 会在合并后的整层校验里失败，而不是被静默剥掉、看起来成功了。
 */

/** #RRGGBB 或 #RRGGBBAA。 */
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, '颜色须为 #RRGGBB 或 #RRGGBBAA');

/** 只收 http(s) 地址：图片会被浏览器与后端渲染器直接加载。 */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const LAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const layerIdSchema = z.string().regex(LAYER_ID_PATTERN, '图层 id 只能含字母数字 _ -');

/** 所有图层共有的几何与显示属性。 */
const baseFields = {
  id: layerIdSchema,
  name: z.string().max(80),
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
  width: z.number().finite().positive().max(20000),
  height: z.number().finite().positive().max(20000),
  /** 角度（deg），绕图层中心旋转 */
  rotation: z.number().finite().min(-360).max(360),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
};

export const IMAGE_LAYER_STATUSES = ['ready', 'generating', 'error'] as const;
export type ImageLayerStatus = (typeof IMAGE_LAYER_STATUSES)[number];

/**
 * 图层角色：决定生成时要不要透明背景。
 * element = 叠在上面的元素（产品、装饰、人物）→ background: transparent，生成后裁掉透明边；
 * background = 整幅底图 → background: opaque，铺满画布，不裁。
 */
export const IMAGE_LAYER_ROLES = ['element', 'background'] as const;
export type ImageLayerRole = (typeof IMAGE_LAYER_ROLES)[number];

/**
 * 生成用的档位。显式列字段而不是 record：这份结构也会进 agent 工具 schema，
 * Gemini 不收 propertyNames（z.record 会生成它），整轮 400。
 */
export const imageGenParamsSchema = z.strictObject({
  aspect_ratio: z.string().max(16).optional(),
  resolution: z.string().max(16).optional(),
  background: z.string().max(16).optional(),
  /** Seedream：像素宽高（如 2048x1536），按图层框比例与画质档位算出 */
  size: z.string().max(16).optional(),
});
export type ImageGenParams = z.infer<typeof imageGenParamsSchema>;

export const imageGenerationSchema = z.strictObject({
  prompt: z.string().max(4000),
  channel: z.string().max(64),
  model: z.string().max(128),
  params: imageGenParamsSchema,
  /** 参考图（CDN 地址），提交时按模型上限截断 */
  referenceUrls: z.array(httpUrlSchema).max(16),
  /** 本次生成的任务号：结果回来时比对它，过期（已被新一次生成覆盖 / 图层被删）的结果直接丢弃 */
  jobId: z.string().max(64).optional(),
  /** aigc 的任务号：任务被中断重跑（进程重启）时接着轮询这一单，而不是重新提交、再花一次钱 */
  taskId: z.string().max(128).optional(),
  /** decompose = 这次「生成中」其实是在拆层（完成后本图层被子图层替换）；失败重试也要走拆层 */
  operation: z.enum(['decompose']).optional(),
  /** 拆层得到的子图层：来自哪个图层（agent 据此认领拆层结果） */
  sourceLayerId: layerIdSchema.optional(),
  error: z.string().max(1000).optional(),
});
export type ImageGeneration = z.infer<typeof imageGenerationSchema>;

export const IMAGE_HISTORY_LIMIT = 5;

export const imageHistoryEntrySchema = z.strictObject({
  src: httpUrlSchema,
  prompt: z.string().max(4000),
  /** ISO 时间 */
  createdAt: z.string().max(40),
});
export type ImageHistoryEntry = z.infer<typeof imageHistoryEntrySchema>;

export const imageLayerSchema = z.strictObject({
  ...baseFields,
  type: z.literal('image'),
  /** CDN 地址（PNG 可带 alpha）；首次生成中 / 失败且无旧图时为 null */
  src: httpUrlSchema.nullable(),
  flipX: z.boolean(),
  flipY: z.boolean(),
  role: z.enum(IMAGE_LAYER_ROLES),
  status: z.enum(IMAGE_LAYER_STATUSES),
  /** 最近一次生成的上下文（重新生成时预填）；纯上传的图片没有 */
  generation: imageGenerationSchema.nullable(),
  /** 最近几次的历史版本（不含当前 src），新的在前 */
  history: z.array(imageHistoryEntrySchema).max(IMAGE_HISTORY_LIMIT),
});
export type ImageLayer = z.infer<typeof imageLayerSchema>;

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;
export const TEXT_DECORATIONS = ['none', 'underline', 'line-through'] as const;
export const TEXT_TRANSFORMS = ['none', 'uppercase'] as const;

export const textStrokeSchema = z.strictObject({
  color: hexColorSchema,
  width: z.number().min(0).max(50),
});
export const textShadowSchema = z.strictObject({
  color: hexColorSchema,
  blur: z.number().min(0).max(100),
  offsetX: z.number().min(-200).max(200),
  offsetY: z.number().min(-200).max(200),
});

/**
 * 文字图层：宽度固定、自动换行，height 是**排版后测得的**高度（前端量完回写、后端渲染同样量），
 * 不是约束——改字号或文案后高度跟着变。
 */
export const textLayerSchema = z.strictObject({
  ...baseFields,
  type: z.literal('text'),
  text: z.string().max(2000),
  fontFamily: z.enum(FONT_FAMILIES),
  fontSize: z.number().min(4).max(1000),
  fontWeight: z.number().int().min(100).max(900).multipleOf(100),
  fontStyle: z.enum(FONT_STYLES),
  fill: hexColorSchema,
  align: z.enum(TEXT_ALIGNS),
  /** 行高倍数 */
  lineHeight: z.number().min(0.5).max(3),
  /** 字间距（设计稿像素） */
  letterSpacing: z.number().min(-50).max(200),
  textDecoration: z.enum(TEXT_DECORATIONS),
  textTransform: z.enum(TEXT_TRANSFORMS),
  stroke: textStrokeSchema.nullable(),
  shadow: textShadowSchema.nullable(),
});
export type TextLayer = z.infer<typeof textLayerSchema>;

export const layerSchema = z.discriminatedUnion('type', [
  imageLayerSchema,
  textLayerSchema,
]);
export type Layer = z.infer<typeof layerSchema>;
export type LayerType = Layer['type'];

export const canvasSchema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  /** 画布底色；transparent = 导出 PNG 时保留透明 */
  background: z.union([hexColorSchema, z.literal('transparent')]),
});
export type DesignCanvas = z.infer<typeof canvasSchema>;

export const MAX_LAYERS = 100;

export const designDocumentSchema = z
  .strictObject({
    version: z.literal(1),
    canvas: canvasSchema,
    layers: z.array(layerSchema).max(MAX_LAYERS),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.layers.forEach((l, i) => {
      if (seen.has(l.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `图层 id 重复：${l.id}`,
          path: ['layers', i, 'id'],
        });
      }
      seen.add(l.id);
    });
  });
export type DesignDocument = z.infer<typeof designDocumentSchema>;

/**
 * 局部字段 patch：所有可改字段的并集（id / type 不可改）。合并进旧图层后**整层**重新过
 * layerSchema——所以「给文字图层 patch 一个 src」会在那一步被 strictObject 拒掉。
 */
export const layerPatchSchema = z.strictObject({
  name: baseFields.name.optional(),
  x: baseFields.x.optional(),
  y: baseFields.y.optional(),
  width: baseFields.width.optional(),
  height: baseFields.height.optional(),
  rotation: baseFields.rotation.optional(),
  opacity: baseFields.opacity.optional(),
  visible: baseFields.visible.optional(),
  locked: baseFields.locked.optional(),
  // image
  src: imageLayerSchema.shape.src.optional(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  role: imageLayerSchema.shape.role.optional(),
  status: imageLayerSchema.shape.status.optional(),
  generation: imageLayerSchema.shape.generation.optional(),
  history: imageLayerSchema.shape.history.optional(),
  // text
  text: textLayerSchema.shape.text.optional(),
  fontFamily: textLayerSchema.shape.fontFamily.optional(),
  fontSize: textLayerSchema.shape.fontSize.optional(),
  fontWeight: textLayerSchema.shape.fontWeight.optional(),
  fontStyle: textLayerSchema.shape.fontStyle.optional(),
  fill: textLayerSchema.shape.fill.optional(),
  align: textLayerSchema.shape.align.optional(),
  lineHeight: textLayerSchema.shape.lineHeight.optional(),
  letterSpacing: textLayerSchema.shape.letterSpacing.optional(),
  textDecoration: textLayerSchema.shape.textDecoration.optional(),
  textTransform: textLayerSchema.shape.textTransform.optional(),
  stroke: textLayerSchema.shape.stroke.optional(),
  shadow: textLayerSchema.shape.shadow.optional(),
});
export type LayerPatch = z.infer<typeof layerPatchSchema>;

export const canvasPatchSchema = canvasSchema.partial();
export type DesignCanvasPatch = z.infer<typeof canvasPatchSchema>;

/** 生成期只许 agent / 生成流水线改的字段：用户的 op 改它们会被拒（问题 3：只锁图片源）。 */
export const GENERATION_OWNED_FIELDS = ['src', 'status', 'generation', 'history'] as const;
