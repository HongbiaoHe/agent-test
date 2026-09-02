import { z } from 'zod';

/**
 * aigc 生成服务的对外类型（本项目只用 image / video 两类）。
 *
 * 上游承诺「只增不改」并可能新增字段，所以一律用 zod 解析（未声明的键被剥掉而不是报错），
 * 拿到强类型结果后再往下传——不写 `as`，也不把 unknown 一路带下去（CLAUDE.md §8）。
 * 契约来源：对接文档 §7 能力发现 / §5 任务创建 / §6 任务查询 / §9 回调。
 */

/** 本项目用到的任务类型（aigc 另有 audio / voice，画布不涉及）。 */
export type AigcMediaType = 'image' | 'video';

export const aigcParamOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

/**
 * 一个参数维度。`input` 决定要不要传（required / optional / derived——derived 是服务端
 * 按参考资源推导的，压根不是入参）；`value_type` 决定取值来源（select 从 options 里选，
 * range 在区间内取；range 只出现在音频维度，画布用不到，故不渲染也不提交）。
 */
export const aigcModelParamSchema = z.object({
  param_type: z.string(),
  label: z.string().optional(),
  input: z.string().optional(),
  value_type: z.string().optional(),
  options: z.array(aigcParamOptionSchema).default([]),
});

/** 跨维度约束：when 全命中 → allow 收窄各维度取值、forbid 的维度整个不可传。 */
export const aigcConstraintSchema = z.object({
  when: z.record(z.string(), z.array(z.string())),
  allow: z.record(z.string(), z.array(z.string())).optional(),
  forbid: z.array(z.string()).optional(),
});

export const aigcModelSchema = z.object({
  model_alias: z.string(),
  identifier: z.string().optional(),
  display_name: z.string().optional(),
  type: z.string(),
  max_prompt: z.number().optional(),
  image_input_number: z.number().default(0),
  video_input_number: z.number().default(0),
  audio_input_number: z.number().default(0),
  params: z.array(aigcModelParamSchema).default([]),
  constraints: z.array(aigcConstraintSchema).default([]),
});

export const aigcChannelSchema = z.object({
  channel: z.string(),
  models: z.array(aigcModelSchema).default([]),
});

export const aigcChannelsDataSchema = z.object({
  channels: z.array(aigcChannelSchema).default([]),
});

export type AigcParamOption = z.infer<typeof aigcParamOptionSchema>;
export type AigcModelParam = z.infer<typeof aigcModelParamSchema>;
export type AigcConstraint = z.infer<typeof aigcConstraintSchema>;
export type AigcModel = z.infer<typeof aigcModelSchema>;
export type AigcChannel = z.infer<typeof aigcChannelSchema>;

/** 接单响应 data（§5.1）。 */
export const aigcCreateTaskDataSchema = z.object({
  task_id: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
});

/** 任务详情 / 回调 body 的 data（§6.1 / §9.2；只取本项目要用的字段）。 */
export const aigcTaskSchema = z.object({
  task_id: z.string(),
  type: z.string().optional(),
  status: z.string(),
  channel: z.string().nullish(),
  model: z.string().nullish(),
  model_alias: z.string().nullish(),
  output_data: z
    .object({
      image_url: z.string().optional(),
      video_url: z.string().optional(),
    })
    .nullish(),
  error_data: z
    .object({ code: z.string().nullish(), message: z.string().nullish() })
    .nullish(),
  cost_usd: z.number().nullish(),
});

export type AigcTask = z.infer<typeof aigcTaskSchema>;

/** aigc 的统一响应信封（§2.3）：成功恒为 code:"success"。 */
export const aigcEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

/**
 * 一次生成用的模型选择：渠道 + 模型别名 + 档位参数（形状 Record<string,string>，
 * 键是 aigc 的 param_type，值是 options[].value）。落在 CanvasNode 与 MediaVersion 上。
 */
export interface AigcMediaConfig {
  channel: string;
  model: string;
  params: Record<string, string>;
}

/** 能力目录（GET /aigc/models 返回）：可选模型 + 该类型的默认选择。 */
export interface AigcCatalog {
  type: AigcMediaType;
  channels: AigcChannel[];
  /** 默认模型（目录里的第一个模型 + 各必填维度的第一个取值）；目录为空时为 null。 */
  default: AigcMediaConfig | null;
}

/** 提交给 aigc 的一份参考资源（§5.5）。url 必须公网可达。 */
export interface AigcReference {
  type: 'image' | 'video' | 'audio';
  role: 'reference' | 'first_frame' | 'last_frame';
  url: string;
}

/** 终态判定（§8.1）：aigc 对外状态机只有这五个值。 */
export function isAigcTerminal(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}
