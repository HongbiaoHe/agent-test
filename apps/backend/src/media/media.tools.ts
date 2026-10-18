import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { MEDIA_BATCH_MAX, MediaService, type MediaType } from './media.service';

/** 工具运行上下文：worker 闭包注入当前会话与可信 userId（不经模型，无注入风险）。 */
export interface MediaToolContext {
  conversationId: string;
  userId: string;
}

const generateSchema = z.object({
  // 设计 §安全：prompt 上限 2000 字符（schema 层兜底，超长由 zod 直接拒绝）
  prompt: z.string().max(2000).describe('图像/视频生成提示词（已与用户确认）'),
  model: z
    .string()
    .optional()
    .describe(
      '模型别名（list_media_models 返回的 model）。用户点名了模型就必须用它；不传 = 默认模型',
    ),
  channel: z
    .string()
    .optional()
    .describe('渠道（同名模型出现在多个渠道时才需要指定）'),
  // 键写死成已知维度而不是 z.record：record 会生成 JSON Schema 的 propertyNames，Gemini 函数声明不认
  // （400 Unknown name "propertyNames"）。这六个也正是 aigc.catalog 的 buildTaskBody 唯一会提交的字段。
  // 值一律 string：目录里的取值本来就是字符串（"8"、"16:9"、"true"），校验按原值比对；
  // 刻意不在 zod 层收窄取值：zod 拒会抛异常废掉一整轮，交给服务端校验后回一条可改正的错误。
  params: z
    .object({
      aspect_ratio: z
        .string()
        .optional()
        .describe('画幅比例，如 "16:9" / "16x9" / "adaptive"'),
      resolution: z
        .string()
        .optional()
        .describe('清晰度，如 "2K" / "1080p" / "medium"'),
      duration: z
        .string()
        .optional()
        .describe('视频时长（秒），字符串，如 "8"'),
      with_audio: z
        .string()
        .optional()
        .describe('视频是否带音频："true" / "false"'),
      background: z.string().optional().describe('背景，如 "transparent"'),
      quality: z.string().optional().describe('画质档，如 "medium"'),
    })
    .optional()
    .describe(
      '档位参数，值必须取自 list_media_models 里该模型的 values（模型没有的维度不要传）。不传的必填项自动取第一个值',
    ),
  referenceVersionIds: z
    .array(z.string())
    .max(14)
    .optional()
    .describe(
      '参考图：引用本会话此前生成且已完成的图片版本 id（工具结果里的 versionId）。张数不能超过该模型的 maxReferenceImages',
    ),
  // 同 params：越界交给服务端回可改正的错误，而不是 zod 抛异常
  count: z
    .number()
    .optional()
    .describe(
      `生成几个（1–${MEDIA_BATCH_MAX}，默认 1）。只有用户明确要求多个/多张/多版时才大于 1`,
    ),
});

type GenerateInput = z.infer<typeof generateSchema>;

/**
 * 触发与禁区话术（设计 §7）：明确「何时用 / 何时不用」，避免模型未经确认就生成。
 * image 与 video 共用，仅替换媒体词。
 */
function discipline(media: string): string {
  return (
    `当用户**已明确确认**要生成${media}时调用本工具，立即异步发起生成并返回 queued（不等待完成；` +
    `进度与结果会实时显示在对话卡片里，不要为查看状态重复调用）。\n` +
    `**何时不用**：你刚拟好提示词、但用户尚未确认要生成时，禁止调用——应先把提示词展示给用户、询问是否生成，得到确认后再调用。\n` +
    `**模型**：用户点名的模型必须照用；用户没指定时，可先调 list_media_models 按需求推荐合适的模型（在回复里说明选择理由），拿不准就不传 model 用默认模型。\n` +
    `**参数校验**：参数不合法时本工具返回 error=invalid_params 与 issues（含 allowed 可选值），请按 issues 修正后重新调用，不要放弃或原样重试。\n` +
    `**数量**：默认只生成 1 个；只有用户明确要求多个时才传 count（最多 ${MEDIA_BATCH_MAX}）。`
  );
}

/**
 * 构造媒体工具数组，闭包带上会话上下文。
 *
 * - list_media_models：查可用模型与每个模型的档位（尺寸/比例、清晰度、时长、音频、参考图上限等）。
 * - generate_image / generate_video：严格校验后按 count 建 N 个生成位（立即入队，不等生成），
 *   返回 { status:'queued', model, channel, params, generations:[{generationId,versionId}] }
 *   ——前端按 generations 插卡片锚点，状态经 media_update 事件实时刷新。
 *   校验不通过返回 { error:'invalid_params', issues }，模型据此改参重试。
 */
export function createMediaTools(svc: MediaService, ctx: MediaToolContext) {
  const listModelsTool = tool(
    async ({ type }: { type: MediaType }) =>
      JSON.stringify(await svc.agentModelCatalog(type)),
    {
      name: 'list_media_models',
      description:
        '查询当前可用的生图 / 生视频模型及每个模型支持的参数（画幅比例、清晰度、时长、音频、背景等可选值，参考图张数上限，提示词长度上限，参数之间的约束规则 rules，以及用途提示 hint）。' +
        '用于在生成前推荐模型或确认用户指定的模型/参数是否可用。目录可能随时增减模型，以本工具返回为准。',
      schema: z.object({
        type: z.enum(['image', 'video']).describe('image 生图 / video 生视频'),
      }),
    },
  );

  const run = async (type: MediaType, input: GenerateInput) => {
    try {
      const r = await svc.createAgentGenerations(
        ctx.conversationId,
        ctx.userId,
        type,
        { ...input, count: input.count ?? 1 },
      );
      if (!r.ok) {
        return JSON.stringify({
          error: 'invalid_params',
          issues: r.issues,
          hint: '按 issues 修正参数后重新调用本工具；需要完整的模型与参数表可调用 list_media_models',
        });
      }
      return JSON.stringify({
        status: 'queued',
        model: r.config.model,
        channel: r.config.channel,
        params: r.config.params,
        generations: r.generations,
      });
    } catch (e) {
      if (e instanceof BusinessException) {
        return JSON.stringify({
          error: e.getResponse(),
          hint: '请改用本会话媒体资产清单或工具结果中的真实 versionId 后重试',
        });
      }
      throw e;
    }
  };

  const generateImageTool = tool(
    (input: GenerateInput) => run('image', input),
    {
      name: 'generate_image',
      description:
        `根据提示词生成图像（异步，可批量）。可用 referenceVersionIds 引用此前生成的图片做图生图（工具结果里的 versionId 即引用键）。\n` +
        discipline('图像'),
      schema: generateSchema,
    },
  );

  const generateVideoTool = tool(
    (input: GenerateInput) => run('video', input),
    {
      name: 'generate_video',
      description:
        `根据提示词生成视频（异步长任务，可批量）。可用 referenceVersionIds 引用此前生成的图片作为参考图（部分模型把第一张当首帧）。\n` +
        discipline('视频'),
      schema: generateSchema,
    },
  );

  // 元组（const 断言只固定字面量形状，不改类型）：解构时各工具保留自己的入参类型
  return [listModelsTool, generateImageTool, generateVideoTool] as const;
}
