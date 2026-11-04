import { tool } from '@langchain/core/tools';
import {
  createImageLayer,
  createTextLayer,
  type DesignDocument,
  type DesignOp,
  FONT_FAMILIES,
  FONT_STYLES,
  httpUrlSchema,
  IMAGE_LAYER_ROLES,
  type Layer,
  type LayerPatch,
  layerPatchSchema,
  MAX_GENERATIONS_PER_RUN,
  TEXT_ALIGNS,
  TEXT_DECORATIONS,
  TEXT_TRANSFORMS,
} from '@agent-test/design-schema';
import { z } from 'zod';
import type { RawEvent } from '../../agent/event-normalizer';
import type { DesignAssetsService } from '../design-assets.service';
import type { DesignDecomposeService } from '../design-decompose.service';
import type { DesignGenerationService } from '../design-generation.service';
import { DesignOpRejected, type DesignService } from '../design.service';
import type { DesignRenderService } from '../render/design-render.service';
import {
  INSPECT_TOOL,
  PREVIEW_TOOL,
  type PreviewArtifact,
} from './preview-injection';

/**
 * 设计 agent 的原子工具集（问题 9）。复刻 / 海报 / 拆分这些「能力」写在系统提示的工作流里，
 * 工具只做最小动作——用户中途说「标题再大点」也走同一套。
 *
 * schema 刻意摊平（不用 discriminatedUnion / z.record）：Gemini 的函数声明对 anyOf 与
 * propertyNames 支持不稳（z.record 实测整轮 400），且扁平字段对模型最好填。
 * 工具内部再把参数归一成真正的图层并过共享 schema 校验，非法就把原因回给模型改参重试。
 *
 * 同理不用 exclusiveMinimum（zod 的 .positive()）与 pattern（.regex()）：Gemini 实测
 * 「Unknown name exclusiveMinimum」整轮 400。下限用 .min(1)，颜色格式交给合并后的整层校验。
 */

/** 颜色参数：格式（#RRGGBB / #RRGGBBAA）由 layerPatchSchema 校验，不进函数声明。 */
const colorParam = z.string().max(9);

const ENGINES = ['gpt-image', 'seedream'] as const;
type Engine = (typeof ENGINES)[number];

export interface DesignToolContext {
  docId: string;
  design: DesignService;
  generation: DesignGenerationService;
  render: DesignRenderService;
  assets: DesignAssetsService;
  decompose: DesignDecomposeService;
  /** 配了 BytePlus key：挂 decompose_layer，生成工具可指定 engine=seedream */
  seedream: boolean;
  publish: (evt: RawEvent) => Promise<void>;
  /** 本次运行已提交的生图次数（跨工具共享计数） */
  generations: { count: number };
}

const geometry = {
  x: z.number().describe('左上角 x（设计稿像素）'),
  y: z.number().describe('左上角 y（设计稿像素）'),
  width: z.number().min(1).describe('宽（设计稿像素）'),
  height: z
    .number()
    .min(1)
    .describe('高（设计稿像素）；文字图层会按内容自动量高，给个估计值即可'),
};

const style = {
  name: z
    .string()
    .max(80)
    .optional()
    .describe('图层名（中文，便于用户在图层面板里认出来）'),
  rotation: z.number().min(-360).max(360).optional(),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  // image
  role: z
    .enum(IMAGE_LAYER_ROLES)
    .optional()
    .describe('image：element=透明背景元素（默认），background=整幅底图'),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  // text
  text: z.string().max(2000).optional(),
  fontFamily: z.enum(FONT_FAMILIES).optional(),
  fontSize: z.number().min(4).max(1000).optional(),
  fontWeight: z
    .number()
    .int()
    .min(100)
    .max(900)
    .optional()
    .describe('100–900，整百'),
  fontStyle: z.enum(FONT_STYLES).optional(),
  fill: colorParam.optional().describe('文字颜色 #RRGGBB'),
  align: z.enum(TEXT_ALIGNS).optional(),
  lineHeight: z.number().min(0.5).max(3).optional(),
  letterSpacing: z.number().min(-50).max(200).optional(),
  textDecoration: z.enum(TEXT_DECORATIONS).optional(),
  textTransform: z.enum(TEXT_TRANSFORMS).optional(),
  strokeColor: colorParam
    .optional()
    .describe('文字描边色；strokeWidth=0 取消描边'),
  strokeWidth: z.number().min(0).max(50).optional(),
  shadowColor: colorParam
    .optional()
    .describe(
      '文字阴影色（可 #RRGGBBAA 带透明度）；shadowBlur 与 offset 一起给',
    ),
  shadowBlur: z.number().min(0).max(100).optional(),
  shadowOffsetX: z.number().min(-200).max(200).optional(),
  shadowOffsetY: z.number().min(-200).max(200).optional(),
  removeShadow: z.boolean().optional().describe('true = 去掉文字阴影'),
};

type StyleInput = {
  [K in keyof typeof style]?: z.infer<(typeof style)[K]>;
};

/** 扁平参数 → 图层 patch（只带出现了的字段；描边/阴影拼回嵌套结构）。 */
function toPatch(
  input: StyleInput & Partial<Record<'x' | 'y' | 'width' | 'height', number>>,
  current?: Layer,
): LayerPatch {
  const {
    strokeColor,
    strokeWidth,
    shadowColor,
    shadowBlur,
    shadowOffsetX,
    shadowOffsetY,
    removeShadow,
    fontWeight,
    ...rest
  } = input;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
  if (fontWeight !== undefined)
    patch.fontWeight = Math.round(fontWeight / 100) * 100;
  const cur = current?.type === 'text' ? current : undefined;
  if (strokeColor !== undefined || strokeWidth !== undefined) {
    const width = strokeWidth ?? cur?.stroke?.width ?? 4;
    patch.stroke =
      width <= 0
        ? null
        : { color: strokeColor ?? cur?.stroke?.color ?? '#000000', width };
  }
  if (removeShadow) patch.shadow = null;
  else if (
    [shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY].some(
      (v) => v !== undefined,
    )
  ) {
    patch.shadow = {
      color: shadowColor ?? cur?.shadow?.color ?? '#00000066',
      blur: shadowBlur ?? cur?.shadow?.blur ?? 12,
      offsetX: shadowOffsetX ?? cur?.shadow?.offsetX ?? 0,
      offsetY: shadowOffsetY ?? cur?.shadow?.offsetY ?? 4,
    };
  }
  return layerPatchSchema.parse(patch);
}

/** 给模型看的文档摘要（比整份 JSON 省 token，且字段名与工具参数一致）。 */
export function summarizeDocument(doc: DesignDocument): string {
  const lines = doc.layers.map((l, i) => {
    const box = `x=${r(l.x)} y=${r(l.y)} w=${r(l.width)} h=${r(l.height)}${l.rotation ? ` rot=${r(l.rotation)}` : ''}${l.opacity < 1 ? ` opacity=${l.opacity}` : ''}${l.visible ? '' : ' hidden'}${l.locked ? ' locked' : ''}`;
    if (l.type === 'text') {
      return `${i}. [text] ${l.id} 「${l.name}」 ${box} | "${l.text.slice(0, 80)}" ${l.fontFamily} ${l.fontSize}px w${l.fontWeight} ${l.fill} ${l.align}`;
    }
    const g = l.generation;
    const gen = g?.prompt ? ` prompt="${g.prompt.slice(0, 80)}"` : '';
    const op =
      l.status === 'generating' && g?.operation === 'decompose'
        ? '(拆层中)'
        : '';
    const from = g?.sourceLayerId ? ` 拆自=${g.sourceLayerId}` : '';
    return `${i}. [image:${l.role}] ${l.id} 「${l.name}」 ${box} | status=${l.status}${op}${l.src ? '' : ' (无图)'}${from}${gen}${g?.error ? ` error=${g.error.slice(0, 120)}` : ''}`;
  });
  return [
    `画布 ${doc.canvas.width}×${doc.canvas.height}，底色 ${doc.canvas.background}，共 ${doc.layers.length} 个图层（自底向上）：`,
    ...(lines.length ? lines : ['（空）']),
  ].join('\n');
}

function r(n: number) {
  return Math.round(n);
}

export function createDesignTools(ctx: DesignToolContext) {
  /** 没配 BytePlus 时只剩 gpt-image 一家，参数照留（类型一致），可选值只有一个 */
  const engineParam = {
    engine: z
      .enum(ctx.seedream ? ENGINES : (['gpt-image'] as const))
      .optional()
      .describe(
        ctx.seedream
          ? 'image：用哪家生图。缺省 = 用户在输入框选的模型。整图（初始生成的满画布底图）一律 seedream'
          : 'image：生图模型（缺省 = 用户选的模型）',
      ),
  };
  const focus = (layerIds: string[], action: string) =>
    ctx.publish({ type: 'design_focus', payload: { layerIds, action } });

  /** 在 mutate 里执行一批 op；不合法时把原因作为工具结果交回模型（不抛，让它改参重试）。 */
  const commit = async (ops: DesignOp[]): Promise<string | null> => {
    try {
      await ctx.design.mutate(ctx.docId, () => ops, 'agent');
      return null;
    } catch (e) {
      if (e instanceof DesignOpRejected) return e.message;
      throw e;
    }
  };

  /** 生成 / 拆层共用的上限检查：拆层一次也只算 1 次 */
  const overLimit = () => ctx.generations.count >= MAX_GENERATIONS_PER_RUN;

  const startGeneration = async (
    layerId: string,
    prompt: string,
    referenceUrls?: string[],
    useCurrentAsReference?: boolean,
    engine?: Engine,
  ): Promise<string> => {
    if (overLimit()) {
      return `本次运行已提交 ${MAX_GENERATIONS_PER_RUN} 次生图，达到上限，未提交 ${layerId}。请先收尾，让用户确认后再继续。`;
    }
    ctx.generations.count++;
    try {
      await ctx.generation.start(
        ctx.docId,
        layerId,
        { prompt, referenceUrls, useCurrentAsReference, engine },
        'agent',
      );
      return `已提交 ${layerId}`;
    } catch (e) {
      ctx.generations.count--;
      return `提交 ${layerId} 失败：${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const addLayers = tool(
    async ({ layers, index }) => {
      const built: Layer[] = [];
      const prompts: {
        id: string;
        prompt: string;
        refs?: string[];
        engine?: Engine;
      }[] = [];
      for (const spec of layers) {
        const {
          type,
          prompt,
          referenceUrls,
          src,
          engine,
          x,
          y,
          width,
          height,
          ...rest
        } = spec;
        try {
          const patch = toPatch(rest);
          const layer: Layer =
            type === 'text'
              ? createTextLayer({
                  x,
                  y,
                  width,
                  height,
                  name: '文字',
                  ...pick(patch, 'text'),
                })
              : createImageLayer({
                  x,
                  y,
                  width,
                  height,
                  name: '图片',
                  ...pick(patch, 'image'),
                  ...(src ? { src: httpUrlSchema.parse(src) } : {}),
                });
          built.push(layer);
          if (type === 'image' && prompt && !src)
            prompts.push({
              id: layer.id,
              prompt,
              refs: referenceUrls,
              engine,
            });
        } catch (e) {
          return `图层参数不合法：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      await focus(
        built.map((l) => l.id),
        `添加 ${built.length} 个图层`,
      );
      const err = await commit([{ type: 'add_layers', layers: built, index }]);
      if (err) return `添加失败：${err}`;
      const gen = await Promise.all(
        prompts.map((p) =>
          startGeneration(p.id, p.prompt, p.refs, undefined, p.engine),
        ),
      );
      return [
        `已添加：${built.map((l) => `${l.id}(${l.type}「${l.name}」)`).join('、')}`,
        ...(gen.length
          ? [
              `生图：${gen.join('；')}（异步进行中，需要看效果时先 wait_for_layers）`,
            ]
          : []),
      ].join('\n');
    },
    {
      name: 'add_layers',
      description:
        '批量添加图层（一次排版通常 5–15 个，务必一次调用加完）。image 图层给了 prompt 就会立即开始生成（异步，图层显示 generating）；不给 prompt 则是空占位，之后用 generate_layer_image 生成。数组顺序 = 自底向上的 z 序。',
      schema: z.object({
        layers: z
          .array(
            z.object({
              type: z.enum(['text', 'image']),
              ...geometry,
              ...style,
              prompt: z
                .string()
                .max(4000)
                .optional()
                .describe(
                  'image：生成这个图层的提示词（英文更稳）。element 角色要写「isolated … on a transparent background, no text」',
                ),
              referenceUrls: z
                .array(z.string())
                .max(8)
                .optional()
                .describe(
                  'image：参考图 CDN 地址（用户附件 / 产品图 / 其它图层的 src）',
                ),
              src: z
                .string()
                .max(2048)
                .optional()
                .describe(
                  'image：直接用这张现成图片（用户附件 / CDN 地址）作图层内容，不生成（复刻时把参考图放上画布再拆层）',
                ),
              ...engineParam,
            }),
          )
          .min(1)
          .max(30),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('插入位置（z 序下标）；缺省放最上层'),
      }),
    },
  );

  const updateLayers = tool(
    async ({ updates }) => {
      const { document } = await ctx.design.document(ctx.docId);
      const ops: DesignOp[] = [];
      try {
        ops.push({
          type: 'update_layers',
          updates: updates.map(({ id, ...fields }) => ({
            id,
            patch: toPatch(
              fields,
              document.layers.find((l) => l.id === id),
            ),
          })),
        });
      } catch (e) {
        return `参数不合法：${e instanceof Error ? e.message : String(e)}`;
      }
      await focus(
        updates.map((u) => u.id),
        '调整图层',
      );
      const err = await commit(ops);
      return err ? `修改失败：${err}` : `已修改 ${updates.length} 个图层`;
    },
    {
      name: 'update_layers',
      description:
        '批量修改图层的位置、尺寸、样式、文案（字段级：只传要改的字段）。',
      schema: z.object({
        updates: z
          .array(
            z.object({
              id: z.string(),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().min(1).optional(),
              height: z.number().min(1).optional(),
              ...style,
            }),
          )
          .min(1)
          .max(50),
      }),
    },
  );

  const deleteLayers = tool(
    async ({ ids }) => {
      await focus(ids, '删除图层');
      const err = await commit([{ type: 'delete_layers', ids }]);
      return err ? `删除失败：${err}` : `已删除 ${ids.join('、')}`;
    },
    {
      name: 'delete_layers',
      description: '删除图层。搭错了优先 update_layers 改，不要删了重加。',
      schema: z.object({ ids: z.array(z.string()).min(1).max(50) }),
    },
  );

  const reorderLayers = tool(
    async ({ order }) => {
      await focus(order, '调整层级');
      const err = await commit([{ type: 'reorder_layers', order }]);
      return err ? `调整失败：${err}` : '已调整层级';
    },
    {
      name: 'reorder_layers',
      description: '重排 z 序：给出全部图层 id 的完整新顺序（自底向上）。',
      schema: z.object({ order: z.array(z.string()).min(1).max(100) }),
    },
  );

  const setCanvas = tool(
    async ({ width, height, background }) => {
      const patch: { width?: number; height?: number; background?: string } =
        {};
      if (width !== undefined) patch.width = Math.round(width);
      if (height !== undefined) patch.height = Math.round(height);
      if (background !== undefined) patch.background = background;
      const err = await commit([{ type: 'set_canvas', patch }]);
      return err ? `修改画布失败：${err}` : '已修改画布';
    },
    {
      name: 'set_canvas',
      description:
        '设置画布尺寸与底色（transparent = 导出带透明的 PNG）。常用：1080×1350（4:5）、1080×1920（9:16）、1080×1080、1920×1080。',
      schema: z.object({
        width: z.number().int().min(64).max(8192).optional(),
        height: z.number().int().min(64).max(8192).optional(),
        background: z.string().optional().describe('#RRGGBB 或 transparent'),
      }),
    },
  );

  const generateLayerImage = tool(
    async ({
      layerId,
      prompt,
      referenceUrls,
      useCurrentAsReference,
      engine,
    }) => {
      await focus([layerId], '生成图片');
      return startGeneration(
        layerId,
        prompt,
        referenceUrls,
        useCurrentAsReference,
        engine,
      );
    },
    {
      name: 'generate_layer_image',
      description: `给一个 image 图层（重新）生成图片：立即返回，图层进入 generating，完成后自动替换并进历史版本。同一步里可以并发调用多个。单次运行最多 ${MAX_GENERATIONS_PER_RUN} 次。`,
      schema: z.object({
        layerId: z.string(),
        prompt: z.string().min(1).max(4000),
        referenceUrls: z.array(z.string()).max(8).optional(),
        useCurrentAsReference: z
          .boolean()
          .optional()
          .describe('以图层当前的图作参考做变体'),
        ...engineParam,
      }),
    },
  );

  const waitForLayers = tool(
    async ({ layerIds, timeoutSeconds }) => {
      const deadline = Date.now() + (timeoutSeconds ?? 240) * 1000;
      for (;;) {
        const { document } = await ctx.design.document(ctx.docId);
        const targets = document.layers.filter(
          (l) =>
            l.type === 'image' &&
            (!layerIds?.length || layerIds.includes(l.id)),
        );
        const pending = targets.filter(
          (l) => l.type === 'image' && l.status === 'generating',
        );
        if (pending.length === 0 || Date.now() > deadline) {
          const lines = targets.map((l) =>
            l.type === 'image'
              ? `${l.id}: ${l.status}${l.status === 'generating' && l.generation?.operation === 'decompose' ? '(拆层中)' : ''}${l.generation?.error ? `（${l.generation.error.slice(0, 160)}）` : ''}`
              : '',
          );
          // 指名等的图层不见了：多半是拆层完成、被子图层替换了
          const gone = (layerIds ?? []).filter(
            (id) => !document.layers.some((l) => l.id === id),
          );
          for (const id of gone) lines.push(describeDecomposed(document, id));
          return `${pending.length ? `超时，仍有 ${pending.length} 个在生成。` : '全部生成结束。'}\n${lines.join('\n')}`;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
    },
    {
      name: 'wait_for_layers',
      description:
        '等图层生成 / 拆层结束（默认等全部 generating 的图层，最多 240 秒；拆层建议给 480），返回每个图层的状态；拆层完成的图层会列出它被替换成的子图层。render_preview 自检前调用。',
      schema: z.object({
        layerIds: z.array(z.string()).optional(),
        timeoutSeconds: z.number().int().min(10).max(480).optional(),
      }),
    },
  );

  const renderPreview = tool(
    async (): Promise<[string, PreviewArtifact]> => {
      const { document } = await ctx.design.document(ctx.docId);
      await focus([], '检查版面');
      const png = await ctx.render.render(document, {
        maxSide: 1024,
        annotate: true,
      });
      // 图不放进工具结果（会被当文本算 token），放 artifact，由 preview-injection 补成用户消息
      return [
        `已渲染当前版面（虚线框 + 标签 = 图层 id；蓝=文字，红=图片），图片紧随其后。\n${summarizeDocument(document)}`,
        { previewPng: png.toString('base64') },
      ];
    },
    {
      name: PREVIEW_TOOL,
      description:
        '渲染当前设计稿给你看（带图层 id 标注）。排完版、生成完后用它自检：文字是否压住主体、留白与对齐、层次与对比度、整体是否有设计感，发现问题就 update_layers 微调。',
      schema: z.object({}),
      responseFormat: 'content_and_artifact',
    },
  );

  const decomposeLayer = tool(
    async ({ layerId, prompt }) => {
      if (overLimit()) {
        return `本次运行已提交 ${MAX_GENERATIONS_PER_RUN} 次生图 / 拆层，达到上限，未拆 ${layerId}。`;
      }
      await focus([layerId], '拆分图层');
      ctx.generations.count++;
      try {
        await ctx.decompose.start(ctx.docId, layerId, prompt, 'agent');
        return `已提交拆层 ${layerId}（异步，通常要 1–3 分钟）：wait_for_layers({ layerIds: ["${layerId}"], timeoutSeconds: 480 }) 等它结束，结束后它会被「底图 + 子图层」替换。`;
      } catch (e) {
        ctx.generations.count--;
        return `拆层 ${layerId} 提交失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: 'decompose_layer',
      description:
        '把一个已有图片的 image 图层拆成「底图 + 最多 16 个透明子图层」（Seedream 拆层，保留原图像素）。完成后原图层被替换：底图留在原位置最底下，子图层按原图位置叠放（generation.sourceLayerId=原图层 id）。用于：初始生成的整图拆层、复刻参考图、用户要求拆分图层。',
      schema: z.object({
        layerId: z.string(),
        prompt: z
          .string()
          .max(2000)
          .optional()
          .describe(
            '可选：指定要拆出哪些元素（英文，如 "Separate the title text, the product bottle, and each decorative leaf into separate layers"）。不给则自动识别主要元素',
          ),
      }),
    },
  );

  const inspectLayers = tool(
    async ({ layerIds }): Promise<[string, PreviewArtifact]> => {
      const { document } = await ctx.design.document(ctx.docId);
      const picked = layerIds
        .map((id) => document.layers.find((l) => l.id === id))
        .filter((l): l is Layer => Boolean(l));
      if (!picked.length) return ['这些图层都不存在', { previewPng: '' }];
      await focus(
        picked.map((l) => l.id),
        '查看图层',
      );
      const sheet = contactSheet(picked);
      const png = await ctx.render.render(sheet, {
        maxSide: 1536,
        annotate: true,
      });
      return [
        `图层总览（每格一个图层，标签 = 图层 id），图片紧随其后：\n${picked
          .map(
            (l) =>
              `${l.id}「${l.name}」 x=${r(l.x)} y=${r(l.y)} w=${r(l.width)} h=${r(l.height)}${l.type === 'image' && l.generation?.prompt ? ` — ${l.generation.prompt.slice(0, 160)}` : ''}`,
          )
          .join('\n')}`,
        { previewPng: png.toString('base64') },
      ];
    },
    {
      name: INSPECT_TOOL,
      description:
        '把指定图层单独拼成一张总览图给你看（每格一个，带 id 标签）。拆层后用它逐个认子图层：哪些是普通文字（要换成可编辑 text 图层）、哪些是设计字或图形（保留为图片）。',
      schema: z.object({
        layerIds: z.array(z.string()).min(1).max(24),
      }),
      responseFormat: 'content_and_artifact',
    },
  );

  const getDocument = tool(
    async () =>
      summarizeDocument((await ctx.design.document(ctx.docId)).document),
    {
      name: 'get_document',
      description: '取当前文档的图层清单（用户可能在你运行期间手动改过）。',
      schema: z.object({}),
    },
  );

  return [
    addLayers,
    updateLayers,
    deleteLayers,
    reorderLayers,
    setCanvas,
    generateLayerImage,
    waitForLayers,
    renderPreview,
    inspectLayers,
    getDocument,
    ...(ctx.seedream ? [decomposeLayer] : []),
  ];
}

/** wait_for_layers 里「指名的图层不见了」：找拆自它的子图层；找不到就是被删了。 */
function describeDecomposed(doc: DesignDocument, id: string): string {
  const children = doc.layers.filter(
    (l) => l.type === 'image' && l.generation?.sourceLayerId === id,
  );
  if (!children.length) return `${id}: 已不存在（被删除）`;
  return [
    `${id}: 拆层完成，已替换为 ${children.length} 个图层（自底向上）：`,
    ...children.map(
      (l) =>
        `  - ${l.id}「${l.name}」 x=${r(l.x)} y=${r(l.y)} w=${r(l.width)} h=${r(l.height)}${l.type === 'image' && l.generation?.prompt ? ` — ${l.generation.prompt.slice(0, 160)}` : ''}`,
    ),
    '下一步：inspect_layers 看这些子图层，普通文字换成可编辑 text 图层。',
  ].join('\n');
}

const SHEET_CELL = 360;
const SHEET_PAD = 28;

/**
 * inspect_layers 的总览：把图层各自 contain 进一格，拼成一份临时文档交给渲染器（带 id 标注）。
 * 灰底：白字、黑字、透明图层在上面都看得清。
 */
export function contactSheet(layers: Layer[]): DesignDocument {
  const cols = Math.min(4, layers.length);
  const rows = Math.ceil(layers.length / cols);
  return {
    version: 1,
    canvas: {
      width: cols * SHEET_CELL,
      height: rows * SHEET_CELL,
      background: '#9A9A9A',
    },
    layers: layers.map((l, i) => {
      const inner = SHEET_CELL - SHEET_PAD * 2;
      const scale = Math.min(inner / l.width, inner / l.height);
      const width = l.width * scale;
      const height = l.height * scale;
      const cx = (i % cols) * SHEET_CELL + SHEET_CELL / 2;
      const cy = Math.floor(i / cols) * SHEET_CELL + SHEET_CELL / 2 + 8;
      const placed = {
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
        rotation: 0,
        opacity: 1,
        visible: true,
      };
      return l.type === 'text'
        ? {
            ...l,
            ...placed,
            fontSize: Math.max(4, l.fontSize * scale),
            letterSpacing: l.letterSpacing * scale,
          }
        : { ...l, ...placed };
    }),
  };
}

const TEXT_ONLY = new Set([
  'text',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fill',
  'align',
  'lineHeight',
  'letterSpacing',
  'textDecoration',
  'textTransform',
  'stroke',
  'shadow',
]);
const IMAGE_ONLY = new Set(['role', 'flipX', 'flipY']);

/** 新建图层时只取属于该类型的字段（模型常把文字字段顺手填到图片上）。 */
function pick(patch: LayerPatch, type: 'text' | 'image'): LayerPatch {
  const drop = type === 'text' ? IMAGE_ONLY : TEXT_ONLY;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!drop.has(k)) out[k] = v;
  return layerPatchSchema.parse(out);
}
