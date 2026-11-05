import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 对话 agent 的生图 / 生视频 / 配音 / 克隆音色工具——Web（backend worker）与 desktop（agent-host）共用同一份
 * 工具名、入参 schema、说明与结果格式；「怎么真正生成」由宿主注入 MediaToolBackend：
 * - backend：直接调 MediaService（apps/backend/src/media/media.tools.ts）；
 * - desktop：经 Web 后端的 /media-api 接口（同一个 MediaService），用户登录 Web 账号后可用。
 */

/** 一次最多生成几个（同 backend MEDIA_BATCH_MAX） */
export const MEDIA_BATCH_MAX = 10;

export type MediaToolType = 'image' | 'video' | 'audio';

/** 参数校验不通过的一项（backend AgentParamIssue 的结构子集，原样回给模型） */
export interface MediaParamIssue {
  field: string;
  message: string;
  value?: string;
}

export interface MediaGenerationRef {
  generationId: string;
  versionId: string;
}

/** 实际提交的模型配置（backend AigcMediaConfig 的结构子集） */
export interface MediaResolvedConfig {
  model: string;
  channel: string;
  params: Record<string, string>;
}

export type MediaGenerateOutcome =
  | { ok: false; issues: MediaParamIssue[] }
  | {
      ok: true;
      config: MediaResolvedConfig;
      generations: MediaGenerationRef[];
    };

export type MediaCloneOutcome =
  | { ok: false; issues: MediaParamIssue[] }
  | { ok: true; config: MediaResolvedConfig; generation: MediaGenerationRef };

export interface MediaGenerateInput {
  prompt: string;
  model?: string;
  channel?: string;
  params?: Record<string, string>;
  referenceVersionIds?: string[];
  count: number;
}

export interface MediaCloneInput {
  sourceVersionId: string;
  language: string;
  demoText: string;
}

export interface MediaToolBackend {
  listModels(type: MediaToolType): Promise<unknown>;
  generate(
    type: MediaToolType,
    input: MediaGenerateInput,
  ): Promise<MediaGenerateOutcome>;
  cloneVoice(input: MediaCloneInput): Promise<MediaCloneOutcome>;
  /** 可改正的业务错误（参考素材不存在 / 不归属等）→ 回给模型的 error 载荷；其它错误返回 null 照常抛出 */
  userError(e: unknown): unknown;
}

/**
 * 生图 / 生视频的档位参数（画布 agent 的 set_node_model 也用这一份）。
 *
 * 键写死成已知维度而不是 z.record：record 会生成 JSON Schema 的 propertyNames，Gemini 函数声明不认
 * （400 Unknown name "propertyNames"）。这六个也正是 aigc.catalog 的 buildTaskBody 唯一会提交的字段。
 * 值一律 string：目录里的取值本来就是字符串（"8"、"16:9"、"true"），校验按原值比对；
 * 刻意不在 zod 层收窄取值：zod 拒会抛异常废掉一整轮，交给服务端校验后回一条可改正的错误。
 */
export const mediaParamsSchema = z
  .object({
    aspect_ratio: z
      .string()
      .optional()
      .describe('画幅比例，如 "16:9" / "16x9" / "adaptive"'),
    resolution: z
      .string()
      .optional()
      .describe('清晰度，如 "2K" / "1080p" / "medium"'),
    duration: z.string().optional().describe('视频时长（秒），字符串，如 "8"'),
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
  );

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
  params: mediaParamsSchema,
  // 上限放宽到各类型上限之和量级：越界交给服务端按模型逐类回可改正的错误，而不是 zod 抛异常
  referenceVersionIds: z
    .array(z.string())
    .max(50)
    .optional()
    .describe(
      '参考素材：本会话此前生成或用户上传的图片 / 视频 / 音频版本 id（工具结果或资产清单里的 versionId，可混放，按类型自动识别）。' +
        '各类型数量不能超过该模型的 maxReferenceImages / maxReferenceVideos / maxReferenceAudios（没有该字段 = 不支持该类型）；生图只收图片',
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

const audioParam = (desc: string) => z.string().optional().describe(desc);

/**
 * 配音入参：与图 / 视频共用 prompt / model / channel / referenceVersionIds / count 的语义，
 * params 换成音频维度——同样写死成显式键而不是 z.record（Gemini 不认 propertyNames，见上），
 * 这些也正是 aigc.catalog 的 AUDIO_PARAM_FIELDS 会提交的字段（language 是克隆专用，不在这里）。
 */
const generateAudioSchema = generateSchema.extend({
  prompt: z
    .string()
    .max(2000)
    .describe(
      '要念的文本（已与用户确认）。seed-audio 中文单次约 400 字内，更长请分段多次生成',
    ),
  params: z
    .object({
      voice_id: audioParam('预置音色（minimax-speech 必填），如 "Calm_Woman"'),
      emotion: audioParam('情感，如 "happy" / "neutral"'),
      language_boost: audioParam('语言增强，如 "Chinese" / "English" / "auto"'),
      format: audioParam('输出格式，如 "mp3" / "wav"'),
      sample_rate: audioParam('采样率，如 "24000"'),
      bitrate: audioParam('比特率，如 "128000"'),
      audio_channel: audioParam('声道："1" 单声道 / "2" 立体声'),
      speech_rate: audioParam('seed-audio 语速，区间 -50~100，"0" 原速'),
      loudness_rate: audioParam('seed-audio 音量，区间 -50~100'),
      pitch_rate: audioParam('音调，区间 -12~12'),
      speed: audioParam('minimax-speech 语速，区间 0.5~2，"1" 原速'),
      volume: audioParam('minimax-speech 音量，区间 0.01~10'),
    })
    .optional()
    .describe(
      '档位参数，值必须取自 list_media_models(type=audio) 里该模型的 values 或 range（模型没有的维度不要传）。不传的必填项自动取第一个值',
    ),
  referenceVersionIds: z
    .array(z.string())
    .max(10)
    .optional()
    .describe(
      '参考素材（仅 seed-audio-1.0 支持）：1–3 段参考音频 = 照该音色念（克隆音色就传 clone_voice 产物 / myVoices 的 versionId）；或 1 张参考图 = 按画面配旁白。图与音频不可混传',
    ),
});

type GenerateAudioInput = z.infer<typeof generateAudioSchema>;

const cloneVoiceSchema = z.object({
  sourceVersionId: z
    .string()
    .describe(
      '用户上传的录音 versionId（附件或资产清单里的 audio）。要求 10–60 秒、清晰单人说话',
    ),
  language: z
    .string()
    .describe(
      '录音的语种（传 list_media_models(type=audio) 里 voiceClone.languages 的 value，如中文 "0"）。必须与录音实际语种一致',
    ),
  demoText: z
    .string()
    .max(200)
    .describe(
      '用复刻音色念的一段示范文案（4–80 字，同录音语种）。产物就是这段音频，之后作参考音色给配音用',
    ),
});

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
 * 构造媒体工具数组。
 *
 * - list_media_models：查可用模型与每个模型的档位（尺寸/比例、清晰度、时长、音频、参考图上限等）。
 * - generate_image / generate_video / generate_audio：严格校验后按 count 建 N 个生成位（立即入队，不等生成），
 *   返回 { status:'queued', model, channel, params, generations:[{generationId,versionId}] }
 *   ——前端按 generations 插卡片锚点，状态经 media_update 事件实时刷新。
 *   校验不通过返回 { error:'invalid_params', issues }，模型据此改参重试。
 * - clone_voice：用上传录音克隆音色（产物是一段音频），返回形状同上（generations 只有 1 个）。
 */
export function createMediaTools(api: MediaToolBackend) {
  const listModelsTool = tool(
    async ({ type }: { type: MediaToolType }) =>
      JSON.stringify(await api.listModels(type)),
    {
      name: 'list_media_models',
      description:
        '查询当前可用的生图 / 生视频 / 配音模型及每个模型支持的参数（画幅比例、清晰度、时长、音频、背景、音色、语速等可选值或区间，参考图 / 参考视频 / 参考音频数量上限，提示词长度上限，参数之间的约束规则 rules，以及用途提示 hint）。' +
        'type=audio 时另附 myVoices（用户克隆过的音色，可跨会话引用）与 voiceClone（clone_voice 可选的语言）。' +
        '用于在生成前推荐模型或确认用户指定的模型/参数是否可用。目录可能随时增减模型，以本工具返回为准。配音只有语音合成，没有音效 / 配乐模型。',
      schema: z.object({
        type: z
          .enum(['image', 'video', 'audio'])
          .describe('image 生图 / video 生视频 / audio 配音'),
      }),
    },
  );

  const run = async (
    type: MediaToolType,
    input: GenerateInput | GenerateAudioInput,
  ) => {
    try {
      const r = await api.generate(type, { ...input, count: input.count ?? 1 });
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
      const error = api.userError(e);
      if (error !== null) {
        return JSON.stringify({
          error,
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
        `根据提示词生成图像（异步，可批量）。可用 referenceVersionIds 引用此前生成或用户上传的图片做图生图（versionId 即引用键）。\n` +
        discipline('图像'),
      schema: generateSchema,
    },
  );

  const generateVideoTool = tool(
    (input: GenerateInput) => run('video', input),
    {
      name: 'generate_video',
      description:
        `根据提示词生成视频（异步长任务，可批量）。可用 referenceVersionIds 引用此前生成或用户上传的图片作参考图（部分模型把第一张当首帧），` +
        `部分模型还能引用视频 / 音频作参考（见 list_media_models 的 maxReferenceVideos / maxReferenceAudios）。\n` +
        discipline('视频'),
      schema: generateSchema,
    },
  );

  const generateAudioTool = tool(
    (input: GenerateAudioInput) => run('audio', input),
    {
      name: 'generate_audio',
      description:
        `把文本合成为语音（配音，异步，可批量）。只有语音合成，没有音效 / 配乐。` +
        `要用用户克隆的音色：model 传 seed-audio-1.0，referenceVersionIds 传 clone_voice 产物（或 list_media_models 的 myVoices）的 versionId。` +
        `minimax-speech-2.8-hd 用预置音色（voice_id），不收参考音频。\n` +
        discipline('配音'),
      schema: generateAudioSchema,
    },
  );

  const cloneVoiceTool = tool(
    async (input: z.infer<typeof cloneVoiceSchema>) => {
      try {
        const r = await api.cloneVoice(input);
        if (!r.ok) {
          return JSON.stringify({
            error: 'invalid_params',
            issues: r.issues,
            hint: '按 issues 修正后重新调用；可选语言见 list_media_models(type=audio) 的 voiceClone.languages',
          });
        }
        return JSON.stringify({
          status: 'queued',
          model: r.config.model,
          channel: r.config.channel,
          params: r.config.params,
          generations: [r.generation],
          next: '克隆完成后，用 generate_audio（model=seed-audio-1.0，referenceVersionIds=[本次 versionId]）即可用该音色配音',
        });
      } catch (e) {
        const error = api.userError(e);
        if (error !== null) {
          return JSON.stringify({
            error,
            hint: '请改用用户上传录音的真实 versionId 后重试',
          });
        }
        throw e;
      }
    },
    {
      name: 'clone_voice',
      description:
        '用用户上传的一段录音克隆音色（异步）：产物是「用复刻音色念 demoText」的一段音频，显示在对话卡片里可试听；' +
        '之后把它的 versionId 作为 generate_audio（seed-audio-1.0）的 referenceVersionIds，就能用这个音色配任意文本。\n' +
        '**何时用**：用户上传了录音并明确要求克隆 / 模仿这个声音时。调用前先和用户确认录音语种与 demo 文案（可由你拟一句 4–80 字的话）。\n' +
        '**要求**：录音 10–60 秒、清晰单人说话；language 必须与录音实际语种一致（不支持跨语言复刻）。' +
        '用户之前克隆过的音色在 list_media_models(type=audio) 的 myVoices 里，可直接复用，不必重复克隆。',
      schema: cloneVoiceSchema,
    },
  );

  // 元组（const 断言只固定字面量形状，不改类型）：解构时各工具保留自己的入参类型
  return [
    listModelsTool,
    generateImageTool,
    generateVideoTool,
    generateAudioTool,
    cloneVoiceTool,
  ] as const;
}
