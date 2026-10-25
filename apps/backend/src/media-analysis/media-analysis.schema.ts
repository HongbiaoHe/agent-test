import { z } from 'zod';

/**
 * 附件理解的结构化输出：视觉模型按素材类型各出一套字段，存进 MediaAnalysis.detail。
 *
 * 字段为画布服务——agent 要拿这些描述决定「这张图能不能当参考、什么风格、什么画幅、写什么提示词」，
 * 所以问的是主体 / 构图 / 风格 / 画面文字 / 能拿来做什么，而不是泛泛的「描述一下」。
 * 不用 z.record：Gemini 拒收 propertyNames（见记忆 gemini-tool-schema-no-zod-record）。
 */

const summary = z
  .string()
  .describe('一句话摘要（不超过 60 字）：这是什么、什么风格');
const usableAs = z
  .array(z.string())
  .describe(
    '在视频 / 图片创作里能拿来做什么，如「产品参考图」「风格参考」「首帧」「配乐」',
  );

export const imageAnalysisSchema = z.object({
  summary,
  subject: z
    .string()
    .describe('主体：画面里的主要人物 / 产品 / 物体及外观要点'),
  scene: z.string().describe('场景与背景'),
  composition: z
    .string()
    .describe('构图与镜头：景别、视角、主体在画面中的位置'),
  lighting_color: z.string().describe('光线与色调'),
  style: z.string().describe('视觉风格：如棚拍产品图、电影感、插画、3D 渲染'),
  orientation: z.string().describe('画幅方向：横版 / 竖版 / 方形'),
  text_in_image: z.string().describe('画面里出现的文字原文；没有就写「无」'),
  usable_as: usableAs,
});

export const videoAnalysisSchema = z.object({
  summary,
  duration_seconds: z.number().describe('时长（秒）'),
  shots: z
    .array(
      z.object({
        start: z.number().describe('起始秒'),
        end: z.number().describe('结束秒'),
        visual: z.string().describe('画面内容'),
        camera: z.string().describe('运镜 / 景别'),
      }),
    )
    .describe('分镜，按时间顺序'),
  audio: z.string().describe('音频：人声内容 / 音乐氛围 / 无声'),
  style: z.string().describe('视觉风格与调色'),
  orientation: z.string().describe('画幅方向：横版 / 竖版 / 方形'),
  text_in_video: z.string().describe('画面里出现的文字；没有就写「无」'),
  usable_as: usableAs,
});

export const audioAnalysisSchema = z.object({
  summary,
  kind: z.string().describe('类型：人声 / 音乐 / 音效 / 混合'),
  duration_seconds: z.number().describe('时长（秒）'),
  transcript: z.string().describe('人声转写原文；没有人声就写「无」'),
  mood: z.string().describe('情绪与氛围'),
  tempo: z.string().describe('节奏 / 速度'),
  suitable_visuals: z.string().describe('适合配什么样的画面'),
  usable_as: usableAs,
});

export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;
export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;
export type AudioAnalysis = z.infer<typeof audioAnalysisSchema>;

/** 能分析的素材类型（与 MediaGeneration.type 同名） */
export type AnalyzableType = 'image' | 'video' | 'audio';

export function isAnalyzableType(t: string): t is AnalyzableType {
  return t === 'image' || t === 'video' || t === 'audio';
}

export const ANALYSIS_SCHEMAS = {
  image: imageAnalysisSchema,
  video: videoAnalysisSchema,
  audio: audioAnalysisSchema,
} as const;

const KIND_WORD: Record<AnalyzableType, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

/** 给视觉模型的指令：说清用途，要求按 JSON 结构用简体中文作答，看不出的写「无法判断」而不是编。 */
export function analysisPrompt(type: AnalyzableType): string {
  return [
    `这是用户发给视频创作助手的一份${KIND_WORD[type]}素材。请仔细${type === 'audio' ? '听' : '看'}完，`,
    '按给定的 JSON 结构用简体中文描述它，供助手决定怎样把它用进图片 / 视频创作（当参考图、定风格、写提示词、配乐）。',
    '只写能从素材里直接确认的内容；看不清或无法判断的字段写「无法判断」，不要猜测或编造。',
  ].join('');
}
