/**
 * aigc 能力目录的对外形状（后端 GET /aigc/models 的返回，权威校验在后端 aigc/aigc.types 的 zod schema）。
 * 画布节点的模型与档位面板据此渲染；模型清单与档位取值一律以接口为准，客户端不硬编码。
 */
export interface AigcParamOption {
  label: string;
  value: string;
}

export interface AigcModelParam {
  param_type: string;
  label?: string;
  /** required 必传 / optional 可不传 / derived 服务端推导（不是入参，不渲染） */
  input?: string;
  /** select 或缺省 = 从 options 里选；range 是连续区间（当前只出现在音频维度） */
  value_type?: string;
  options: AigcParamOption[];
}

/**
 * 档位间的联动规则（aigc 目录原样透出）：`when` 全部命中时，`forbid` 的维度不能传，
 * `allow` 的维度只能取其中的值。`when` 里也会引用 derived 维度（有没有参考图等）。
 */
export interface AigcConstraint {
  when: Record<string, string[]>;
  allow?: Record<string, string[]>;
  forbid?: string[];
}

export interface AigcModel {
  model_alias: string;
  identifier?: string;
  display_name?: string;
  type: string;
  /** 各类参考素材最多收几个（0 = 不收）；超出的部分提交时被丢掉 */
  image_input_number: number;
  video_input_number: number;
  audio_input_number: number;
  params: AigcModelParam[];
  constraints: AigcConstraint[];
  /** 视频模型的参考图以什么 role 提交（我方按模型名单推出，见后端 videoRefRole） */
  ref_role?: 'reference' | 'first_frame' | 'last_frame';
}

export interface AigcChannelModels {
  channel: string;
  models: AigcModel[];
}

/** 一次生成的模型选择：渠道 + 模型别名 + 档位（键是 param_type，值是 options[].value）。 */
export interface AigcMediaConfig {
  channel: string;
  model: string;
  params: Record<string, string>;
}

export interface AigcCatalog {
  type: 'image' | 'video';
  channels: AigcChannelModels[];
  /** 默认模型（目录第一个 + 各必填维度第一个取值）；目录为空时为 null */
  default: AigcMediaConfig | null;
}
