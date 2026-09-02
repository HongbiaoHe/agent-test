import type {
  AigcCatalog,
  AigcChannel,
  AigcMediaConfig,
  AigcMediaType,
  AigcModel,
  AigcModelParam,
  AigcReference,
} from './aigc.types';

/**
 * 能力目录的纯计算：默认模型、档位参数的收窄与提交体拼装。
 * 全是纯函数（无 IO、无 DI），便于单测，也让 service 只剩「取目录 + 发请求」。
 */

/** 只有这些维度是我们会提交的：derived 是服务端推导的，range 只出现在音频维度。 */
export function selectableParams(model: AigcModel): AigcModelParam[] {
  return model.params.filter(
    (p) =>
      p.input !== 'derived' && p.value_type !== 'range' && p.options.length > 0,
  );
}

/** 在目录里按 (channel, alias) 找模型；找不到返回 null。 */
export function findModel(
  channels: readonly AigcChannel[],
  channel: string,
  alias: string,
): { channel: string; model: AigcModel } | null {
  const ch = channels.find((c) => c.channel === channel);
  const model = ch?.models.find((m) => m.model_alias === alias);
  return ch && model ? { channel: ch.channel, model } : null;
}

/**
 * 默认模型 = 目录里的**第一个**模型（用户需求：默认就用第一个），
 * 默认档位 = 每个必填维度的第一个取值。可选维度一律不传，交给渠道自己的缺省。
 */
export function defaultConfig(
  channels: readonly AigcChannel[],
): AigcMediaConfig | null {
  for (const ch of channels) {
    const model = ch.models[0];
    if (!model) continue;
    return {
      channel: ch.channel,
      model: model.model_alias,
      params: defaultParams(model),
    };
  }
  return null;
}

/** 各必填维度取第一个取值（可选维度留空）。 */
export function defaultParams(model: AigcModel): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of selectableParams(model)) {
    if (p.input === 'required') params[p.param_type] = p.options[0].value;
  }
  return params;
}

/** 目录 + 默认选择，直接回给前端。 */
export function toCatalog(
  type: AigcMediaType,
  channels: AigcChannel[],
): AigcCatalog {
  return { type, channels, default: defaultConfig(channels) };
}

/**
 * 推导维度（input=derived）的当前取值：服务端按本次参考资源自己算，
 * 我们这边也要算一份——`constraints` 的 `when` 会拿它当条件（§7）。
 */
export function derivedDims(
  references: readonly AigcReference[],
): Record<string, string> {
  const has = (t: AigcReference['type']) =>
    references.some((r) => r.type === t) ? 'yes' : 'no';
  return {
    input_has_image: has('image'),
    input_has_video: has('video'),
    input_has_audio: has('audio'),
    input_has_frame_control: references.some(
      (r) => r.role === 'first_frame' || r.role === 'last_frame',
    )
      ? 'yes'
      : 'no',
  };
}

/**
 * 把用户选的档位收窄成「这个模型此刻真能接受」的一份参数：
 *
 *  1. 丢掉该模型没有的维度、以及 derived / range 维度（传了会被 aigc 的字段白名单拒）；
 *  2. 必填维度缺值 → 补第一个取值；
 *  3. 套 `constraints`：命中 `forbid` 的维度整个删掉，命中 `allow` 的维度取交集，
 *     当前值不在交集里就换成交集的第一个。
 *
 * 为什么在提交前就改而不是让 aigc 拒：这些约束依赖 derived 维度（有没有参考图/首帧），
 * 而参考图是画布连线决定的、用户在面板上选档位时并不知道；直接拒会让「明明选好了却生成失败」
 * 变成常态（如 minimax-h3 一接首帧就禁 aspect_ratio、veo-3.1 选 4k 就只许 8 秒）。
 * 第 3 步循环到稳定：改一个值可能让另一条规则开始命中。
 */
export function sanitizeParams(
  model: AigcModel,
  requested: Record<string, string>,
  derived: Record<string, string> = {},
): Record<string, string> {
  const dims = selectableParams(model);
  const chosen: Record<string, string> = {};
  for (const p of dims) {
    const value = requested[p.param_type];
    const valid = p.options.some((o) => o.value === value);
    if (valid) chosen[p.param_type] = value;
    else if (p.input === 'required') chosen[p.param_type] = p.options[0].value;
  }

  for (let pass = 0; pass < 3; pass++) {
    const current = { ...chosen, ...derived };
    const allow = new Map<string, string[]>();
    const forbid = new Set<string>();
    for (const rule of model.constraints) {
      const hit = Object.entries(rule.when).every(([dim, values]) => {
        const v = current[dim];
        // 没有当前值的维度不参与命中（§7：不传它时引用它的规则不会命中）
        return v !== undefined && values.includes(v);
      });
      if (!hit) continue;
      for (const dim of rule.forbid ?? []) forbid.add(dim);
      for (const [dim, values] of Object.entries(rule.allow ?? {})) {
        const prev = allow.get(dim);
        allow.set(
          dim,
          prev ? prev.filter((v) => values.includes(v)) : [...values],
        );
      }
    }

    let changed = false;
    for (const dim of forbid) {
      if (dim in chosen) {
        delete chosen[dim];
        changed = true;
      }
    }
    for (const [dim, values] of allow) {
      if (forbid.has(dim) || values.length === 0) continue;
      const p = dims.find((d) => d.param_type === dim);
      if (!p) continue;
      const has = dim in chosen;
      if (has && values.includes(chosen[dim])) continue;
      if (!has && p.input !== 'required') continue;
      chosen[dim] = values[0];
      changed = true;
    }
    if (!changed) break;
  }

  return chosen;
}

/**
 * 视频参考图挂什么 role：
 *  - byteplus / fal 消费首尾帧，用 `first_frame`（图生视频，全部 seedance 与 minimax-h3 都支持，
 *    而 `reference` 只有 seedance-2 家族支持，1.5-pro 会被接单期拒）；
 *  - 其余渠道（google / kie）不消费 `asset://` 之外的首尾帧语义，用缺省的 `reference`。
 * 见对接文档 §5.5「role 的模型能力限制」。
 */
export function videoRefRole(channel: string): AigcReference['role'] {
  return channel === 'byteplus' || channel === 'fal'
    ? 'first_frame'
    : 'reference';
}

/** param_type → 接单请求里的字段名与取值形状（§5.1 / §5.2）。 */
const PARAM_FIELDS: Record<
  string,
  { field: string; cast: (v: string) => string | number | boolean }
> = {
  aspect_ratio: { field: 'aspect_ratio', cast: (v) => v },
  resolution: { field: 'resolution', cast: (v) => v },
  duration: { field: 'duration_seconds', cast: (v) => Number(v) },
  with_audio: { field: 'with_audio', cast: (v) => v === 'true' },
  thinking: { field: 'thinking', cast: (v) => v === 'true' },
};

export interface AigcGenerationRequest {
  type: AigcMediaType;
  prompt: string;
  /** 已经过 sanitizeParams 的档位 */
  config: AigcMediaConfig;
  references: readonly AigcReference[];
  callbackUrl?: string;
  metadata?: Record<string, string>;
}

/**
 * 拼接单请求体。档位参数不原样铺开——每个维度对应的字段名与类型都要按文档映射
 * （`duration` → `duration_seconds` 且是整数，`with_audio` 是布尔），
 * 认不出的维度直接丢掉：请求体是严格字段白名单，多传一个字段整单就被拒（§5.10 ④）。
 */
export function buildTaskBody(
  req: AigcGenerationRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    channel: req.config.channel,
    model: req.config.model,
  };
  for (const [dim, value] of Object.entries(req.config.params)) {
    const mapped = PARAM_FIELDS[dim];
    if (!mapped) continue;
    const cast = mapped.cast(value);
    if (typeof cast === 'number' && !Number.isFinite(cast)) continue;
    body[mapped.field] = cast;
  }
  if (req.references.length > 0) {
    body.reference_resources = req.references.map((r) => ({
      type: r.type,
      role: r.role,
      url: r.url,
    }));
  }
  if (req.callbackUrl) body.callback_url = req.callbackUrl;
  if (req.metadata && Object.keys(req.metadata).length > 0) {
    body.metadata = req.metadata;
  }
  return body;
}

/** 接单路径：image → /tasks/images，video → /tasks/videos。 */
export function taskPath(type: AigcMediaType): string {
  return type === 'image' ? '/tasks/images' : '/tasks/videos';
}
