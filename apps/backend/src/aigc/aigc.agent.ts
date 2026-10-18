import { derivedDims, selectableParams, videoRefRole } from './aigc.catalog';
import type {
  AigcChannel,
  AigcConstraint,
  AigcMediaType,
  AigcModel,
  AigcReference,
} from './aigc.types';

/**
 * 给对话 agent（Spark）用的能力目录视图与**严格**参数校验。纯函数，无 IO。
 *
 * 与 aigc.catalog 的 sanitizeParams 的分工：画布是用户在面板上点选，非法值静默收窄最省事；
 * agent 是模型自己填参数，静默改写会让它以为「4 秒」生效了、回复里还这么跟用户说。
 * 所以这里显式传了的非法值一律报错（带可选值），交回模型改参重试；只有没传的必填维度才自动补。
 */

/**
 * 模型用途提示（给 agent 推荐模型用）。只写已知模型的定位，目录里新增的模型没有提示也能用——
 * 能力差异（参考图张数、时长、清晰度、透明背景、音频）已从目录本身推出来，不在这里重复。
 */
const MODEL_HINTS: Record<string, string> = {
  'seedream-4.5': '写实与通用场景，2K/4K 高清，参考图多（14 张）',
  'seedream-5-lite': 'Seedream 5 轻量版，通用出图，最高 4K',
  'seedream-5-pro': 'Seedream 5 旗舰，画质优先',
  'gpt-image-2': '指令遵循与文字排版强',
  'gpt-image-2.5-flare': '指令遵循与文字排版强，支持透明背景',
  'gpt-image-2.5-sunburst': '指令遵循与文字排版强，支持透明背景',
  'grok-imagine-image-2': '画幅最全（含 2:1、20:9 等长图比例）',
  'nano-banana': '快速通用编辑/出图，参考图最多 3 张',
  'nano-banana-2': '多图融合与编辑，画幅极全（含 1:8、8:1）',
  'nano-banana-2-lite': '轻量快速版，适合草稿',
  'nano-banana-pro': '复杂构图、画面内文字与信息图效果好，最高 4K',
  'nano-banana-2.1': 'Nano Banana 2 新版，多图融合与编辑',
  'seedance-1.5-pro': '经典图生视频（参考图作首帧），支持音频',
  'seedance-2': '多模态参考（图/视频）生视频，最高 4K、15 秒',
  'seedance-2-fast': 'Seedance 2 快速版，480p/720p，性价比高',
  'seedance-2-mini': 'Seedance 2 轻量版，480p/720p',
  'seedance-2.5': '最长 30 秒，参考图最多 30 张，支持首尾帧',
  'minimax-h3': '运动表现好，最高 4K',
  'minimax-h3-max': 'MiniMax H3 增强版，提示词上限高',
  'wan-3.0': '时长灵活（2–30 秒）',
  'kling-3-video': '人物动作与镜头运动表现好',
  'veo-3.1': '电影感画面，原生音频；1080p/4k 或带参考图时只能 8 秒',
  'veo-3.1-fast': 'Veo 3.1 快速版；1080p/4k 或带参考图时只能 8 秒',
  'gemini-omni-flash': '快速生成，720p，4–10 秒',
};

/** 一个参数维度在 agent 眼里的样子：是否必填 + 可传的原值。 */
export interface AgentParamSpec {
  required: boolean;
  values: string[];
}

export interface AgentModelView {
  model: string;
  channel: string;
  name: string;
  default?: true;
  hint?: string;
  maxPromptChars?: number;
  maxReferenceImages: number;
  params: Record<string, AgentParamSpec>;
  /** constraints 翻译成的人话规则 */
  rules?: string[];
}

export interface AgentCatalogView {
  type: AigcMediaType;
  note: string;
  models: AgentModelView[];
}

/** 一条校验问题：哪个字段、传了什么、为什么不行、可以传什么。 */
export interface AgentParamIssue {
  field: string;
  value?: string;
  message: string;
  allowed?: string[];
}

/** derived 维度的人话（只用于把 constraints 翻译给模型看）。 */
const DERIVED_TEXT: Record<string, { yes: string; no: string }> = {
  input_has_image: { yes: '带参考图', no: '不带参考图' },
  input_has_video: { yes: '带参考视频', no: '不带参考视频' },
  input_has_audio: { yes: '带参考音频', no: '不带参考音频' },
  input_has_frame_control: { yes: '使用首尾帧', no: '不使用首尾帧' },
};

function describeWhen(when: AigcConstraint['when']): string {
  const parts: string[] = [];
  for (const [dim, values] of Object.entries(when)) {
    const text = DERIVED_TEXT[dim];
    if (text) {
      // ["yes","no"] 恒命中：这条规则其实无条件
      if (values.includes('yes') && values.includes('no')) continue;
      parts.push(values.includes('yes') ? text.yes : text.no);
    } else {
      parts.push(`${dim}=${values.join('/')}`);
    }
  }
  return parts.length ? parts.join(' 且 ') : '任何情况下';
}

export function describeConstraint(rule: AigcConstraint): string {
  const cond = describeWhen(rule.when);
  const effects: string[] = [];
  for (const [dim, values] of Object.entries(rule.allow ?? {})) {
    effects.push(`${dim} 只能取 ${values.join('/')}`);
  }
  for (const dim of rule.forbid ?? []) effects.push(`不能传 ${dim}`);
  return `${cond}：${effects.join('；')}`;
}

/** 目录 → 给 agent 看的精简视图（去掉 derived / range 维度与展示用 label，省 token）。 */
export function toAgentCatalog(
  type: AigcMediaType,
  channels: readonly AigcChannel[],
): AgentCatalogView {
  const models: AgentModelView[] = [];
  for (const ch of channels) {
    for (const m of ch.models) {
      const params: Record<string, AgentParamSpec> = {};
      for (const p of selectableParams(m)) {
        params[p.param_type] = {
          required: p.input === 'required',
          values: p.options.map((o) => o.value),
        };
      }
      const view: AgentModelView = {
        model: m.model_alias,
        channel: ch.channel,
        name: m.display_name ?? m.model_alias,
        maxReferenceImages: m.image_input_number,
        params,
      };
      if (models.length === 0) view.default = true;
      const hint = MODEL_HINTS[m.model_alias];
      if (hint) view.hint = hint;
      if (m.max_prompt) view.maxPromptChars = m.max_prompt;
      if (m.constraints.length) {
        view.rules = m.constraints.map(describeConstraint);
      }
      models.push(view);
    }
  }
  return {
    type,
    note: 'params 只能传 values 里的原值（如 gpt-image 的画幅写 16x9 而不是 16:9；duration=-1 表示自动）。未传的必填参数取第一个值，可选参数不传则用渠道缺省。',
    models,
  };
}

/**
 * 按 agent 给的模型名找模型。不传 → 目录第一个（默认模型）。
 * 先精确匹配别名，再宽松匹配（忽略大小写/空格/连字符，也认展示名，如「Nano Banana Pro」）。
 * 同一别名出现在多个渠道时取目录顺序的第一个，可用 channel 指定。
 */
export function resolveAgentModel(
  channels: readonly AigcChannel[],
  requested: { model?: string; channel?: string },
): { channel: string; model: AigcModel } | { issue: AgentParamIssue } {
  const all = channels.flatMap((c) =>
    c.models.map((m) => ({ channel: c.channel, model: m })),
  );
  if (!requested.model) {
    const first = all[0];
    if (!first) {
      return { issue: { field: 'model', message: '当前没有可用的模型' } };
    }
    return first;
  }
  const loose = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const want = requested.model;
  const inChannel = all.filter(
    (x) => !requested.channel || x.channel === requested.channel,
  );
  const hit =
    inChannel.find((x) => x.model.model_alias === want) ??
    inChannel.find(
      (x) =>
        loose(x.model.model_alias) === loose(want) ||
        (x.model.display_name !== undefined &&
          loose(x.model.display_name) === loose(want)),
    );
  if (hit) return hit;
  return {
    issue: {
      field: requested.channel ? 'model/channel' : 'model',
      value: requested.channel ? `${requested.channel}/${want}` : want,
      message: `没有这个模型${requested.channel ? `（渠道 ${requested.channel}）` : ''}`,
      allowed: [...new Set(inChannel.map((x) => x.model.model_alias))],
    },
  };
}

/**
 * agent 侧的 derived 维度：按「这次会带几张参考图、以什么 role 提交」推算，
 * 与 MediaProcessor 真提交时的算法一致（视频 i2v-only 模型挂 first_frame）。
 */
export function agentDerivedDims(
  type: AigcMediaType,
  model: string,
  referenceCount: number,
): Record<string, string> {
  const role: AigcReference['role'] =
    type === 'video' ? videoRefRole(model) : 'reference';
  const refs: AigcReference[] = Array.from({ length: referenceCount }, () => ({
    type: 'image',
    role,
    url: '',
  }));
  return derivedDims(refs);
}

function ruleHits(rule: AigcConstraint, current: Record<string, string>) {
  return Object.entries(rule.when).every(([dim, values]) => {
    const v = current[dim];
    return v !== undefined && values.includes(v);
  });
}

/**
 * 严格校验一次生成请求。显式传入的参数：未知维度 / 非法取值 / 违反 constraints → 报错；
 * 未传的必填维度补第一个取值（若被 constraints 收窄则取允许值的第一个）。
 * 另查提示词长度与参考图张数。通过时返回最终要提交的档位。
 */
export function validateAgentRequest(
  model: AigcModel,
  req: {
    params: Record<string, string>;
    prompt: string;
    referenceCount: number;
    derived: Record<string, string>;
  },
):
  | { ok: true; params: Record<string, string> }
  | { ok: false; issues: AgentParamIssue[] } {
  const issues: AgentParamIssue[] = [];
  const dims = selectableParams(model);
  const derivedNames = new Set(
    model.params.filter((p) => p.input === 'derived').map((p) => p.param_type),
  );

  const explicit: Record<string, string> = {};
  for (const [dim, value] of Object.entries(req.params)) {
    const p = dims.find((d) => d.param_type === dim);
    if (!p) {
      issues.push({
        field: `params.${dim}`,
        value,
        message: derivedNames.has(dim)
          ? `${dim} 由服务端按参考资源自动推导，不能传`
          : `${model.model_alias} 不支持参数 ${dim}`,
        allowed: dims.map((d) => d.param_type),
      });
      continue;
    }
    if (!p.options.some((o) => o.value === value)) {
      issues.push({
        field: `params.${dim}`,
        value,
        message: `${model.model_alias} 的 ${dim} 不支持取值 ${value}`,
        allowed: p.options.map((o) => o.value),
      });
      continue;
    }
    explicit[dim] = value;
  }

  const chosen: Record<string, string> = { ...explicit };
  for (const p of dims) {
    if (p.input === 'required' && !(p.param_type in chosen)) {
      chosen[p.param_type] = p.options[0].value;
    }
  }

  // constraints：显式值违规 → 报错（同一维度只报一次）；自动补的值违规 → 换成允许值。
  // 循环到稳定：改一个自动值可能让另一条规则开始命中（与 sanitizeParams 同理）。
  const reported = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const rule of model.constraints) {
      if (!ruleHits(rule, { ...chosen, ...req.derived })) continue;
      // 「resolution=1080p 时」/「任何情况下」：后者再接「时」不通顺
      const cond = describeWhen(rule.when);
      const at = cond === '任何情况下' ? cond : `${cond}时`;
      for (const dim of rule.forbid ?? []) {
        if (!(dim in chosen)) continue;
        if (dim in explicit) {
          if (!reported.has(dim)) {
            reported.add(dim);
            issues.push({
              field: `params.${dim}`,
              value: chosen[dim],
              message: `${at} ${model.model_alias} 不能传 ${dim}，请去掉它`,
            });
          }
          continue;
        }
        delete chosen[dim];
        changed = true;
      }
      for (const [dim, values] of Object.entries(rule.allow ?? {})) {
        if (!(dim in chosen) || values.includes(chosen[dim])) continue;
        if (!dims.some((d) => d.param_type === dim)) continue;
        if (dim in explicit) {
          if (!reported.has(dim)) {
            reported.add(dim);
            issues.push({
              field: `params.${dim}`,
              value: chosen[dim],
              message: `${at} ${model.model_alias} 的 ${dim} 只能取 ${values.join('/')}`,
              allowed: values,
            });
          }
          continue;
        }
        chosen[dim] = values[0];
        changed = true;
      }
    }
    if (!changed) break;
  }

  if (model.max_prompt && req.prompt.length > model.max_prompt) {
    issues.push({
      field: 'prompt',
      message: `提示词 ${req.prompt.length} 字符，超过 ${model.model_alias} 的上限 ${model.max_prompt}`,
    });
  }
  if (req.referenceCount > model.image_input_number) {
    issues.push({
      field: 'referenceVersionIds',
      message:
        model.image_input_number === 0
          ? `${model.model_alias} 不支持参考图`
          : `${model.model_alias} 最多 ${model.image_input_number} 张参考图，传了 ${req.referenceCount} 张`,
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, params: chosen };
}
