import type {
  AigcModel,
  AigcModelParam,
  AigcParamOption,
  CanvasIoType,
  CanvasNodeType,
} from "@/lib/api";

import { CANVAS_NODE_IO, upstreamOutputType } from "./node-io";
import type { NodeInputSource } from "./node-io";

/**
 * 生成节点档位的纯计算：展示文本、排序，以及按目录 `constraints` 收窄档位。
 *
 * 收窄规则与后端 `aigc.catalog.ts` 的 `sanitizeParams` 是**同一套**（后端提交前还会再收一次）。
 * 前端也算一遍，是为了面板上显示的就是真会提交的值，并把此刻选不了的取值置灰——
 * 否则会出现「选了 4 秒、提交上去却是 8 秒」这种看不见的改写。
 */

/** 维度在面板上的英文名。没映射到的退回目录 label（中文时再退回 param_type） */
const PARAM_LABEL: Record<string, string> = {
  aspect_ratio: "Ratio",
  resolution: "Resolution",
  duration: "Duration",
  with_audio: "Audio",
  thinking: "Thinking",
  background: "Background",
  quality: "Quality",
};

/** 面板与摘要里的维度顺序：画幅 → 清晰度 → 时长 → 音频，其余按目录顺序排在后面 */
const DIM_ORDER = ["aspect_ratio", "resolution", "duration", "with_audio"];

/** 可选维度未选值时的占位：不传该维度，由渠道自己的缺省决定。 */
export const AUTO = "Auto";

/** 含中日韩字符：目录里部分 label 是中文（开/关、自动、背景…），面板是英文 */
const CJK = /[　-鿿]/;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 取值的展示文本。优先用目录给的 label（"12s"、"16:9"、"720p"——value 往往是
 * "12" / "16x9" / "std" 这类给接口看的写法）；label 是中文时退回由 value 推出的英文。
 */
export function optionText(o: AigcParamOption): string {
  const label = o.label?.trim();
  // 首字母大写：目录里混着 "adaptive" 与 "Adaptive"，同一排里大小写不一很扎眼
  if (label && !CJK.test(label)) return capitalize(label);
  if (o.value === "true") return "On";
  if (o.value === "false") return "Off";
  if (o.value === "-1" || o.value === "auto") return AUTO;
  return capitalize(o.value);
}

export function paramLabel(p: AigcModelParam): string {
  const mapped = PARAM_LABEL[p.param_type];
  if (mapped) return mapped;
  if (p.label && !CJK.test(p.label)) return p.label;
  return capitalize(p.param_type.replace(/_/g, " "));
}

/**
 * 这个模型上用户真能选的维度（derived 是服务端按参考图推导的、range 只出现在音频维度，
 * 两者都不渲染），按 DIM_ORDER 排好
 */
export function orderedParams(model: AigcModel): AigcModelParam[] {
  const rank = (p: AigcModelParam) => {
    const i = DIM_ORDER.indexOf(p.param_type);
    return i === -1 ? DIM_ORDER.length : i;
  };
  return model.params
    .filter(
      (p) =>
        p.input !== "derived" &&
        p.value_type !== "range" &&
        p.options.length > 0,
    )
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * 下拉里的排列顺序。时长按秒数从短到长（目录给的顺序是乱的，如 12s 排第一）；
 * 其它维度保留目录顺序。只改显示顺序，不影响默认值（仍是目录第一个）。
 */
export function sortedOptions(p: AigcModelParam): AigcParamOption[] {
  if (p.param_type !== "duration") return p.options;
  return [...p.options].sort((a, b) => Number(a.value) - Number(b.value));
}

/** 目录里是否自带一档「自动」（如时长 -1、比例 auto）——有就不再补一个 Auto，两枚并排分不清 */
export function hasOwnAuto(p: AigcModelParam): boolean {
  return p.options.some((o) => optionText(o) === AUTO);
}

/** 上游节点的最小形状（resolveInputs 的结果里只用到这几项） */
type UpstreamSource = Pick<
  NodeInputSource,
  "nodeType" | "outputs" | "mediaStatus"
>;

/**
 * 一路上游在这次生成里的去向：
 * - used：会被提交，label 是它在提示词里的叫法（`Image 1` / `Video 1` / `Audio 1`，按类型各自计数）；
 * - pending：既没产物、也没在生成（没触发过 / 失败了 / 没传文件）——排队 / 生成中的上游照常提交，服务端会等它；
 * - type：产物类型这个节点不收（历史遗留的非法边）；
 * - frame：首帧模式的视频模型只认第一张图，后面的图不提交；
 * - limit：超出所选模型这类素材的上限。
 */
export type ReferenceFate =
  | { used: true; type: CanvasIoType; label: string }
  | { used: false; reason: "pending" | "type" | "frame" | "limit" };

const TYPE_WORD: Record<CanvasIoType, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

/**
 * 这次生成真正会提交哪些参考素材——后端三步的镜像，三处必须同一套规则：
 *  1. 按入边顺序收目标节点接受的类型（collectGenerationInputs）；
 *  2. 首帧模式的视频模型只取第一张图（MediaProcessor.loadRefUrls）；
 *  3. 图 / 视频 / 音频各自截到模型上限（AigcService.submit）。
 * 模型目录还没到手（model 为 null）时先不截上限。
 * derived 维度（`constraints.when` 会拿它们当条件）按真会提交的那些算，与后端 `derivedDims` 同义。
 */
export function planReferences(
  inputs: readonly UpstreamSource[],
  target: CanvasNodeType,
  model: AigcModel | null,
): { fates: ReferenceFate[]; derived: Record<string, string> } {
  const accepted = CANVAS_NODE_IO[target].inputs;
  const imageRole =
    target === "video_gen" ? (model?.ref_role ?? "reference") : "reference";
  const limits: Record<CanvasIoType, number> = model
    ? {
        image: model.image_input_number,
        video: model.video_input_number,
        audio: model.audio_input_number,
      }
    : { image: Infinity, video: Infinity, audio: Infinity };
  const used: Record<CanvasIoType, number> = { image: 0, video: 0, audio: 0 };
  let images = 0;

  const fates = inputs.map((s): ReferenceFate => {
    const type = upstreamOutputType(s, accepted);
    if (!type) {
      // 收不了的类型（不论有没有产物）不算缺；收得了却既没产物也没在生成 → 还没就绪
      const produces = CANVAS_NODE_IO[s.nodeType].outputs;
      return {
        used: false,
        reason: produces.some((t) => accepted.includes(t)) ? "pending" : "type",
      };
    }
    if (type === "image") {
      if (imageRole === "first_frame" && images >= 1) {
        return { used: false, reason: "frame" };
      }
      images++;
    }
    if (used[type] >= limits[type]) {
      return { used: false, reason: "limit" };
    }
    used[type]++;
    return {
      used: true,
      type,
      label: `${TYPE_WORD[type]} ${used[type]}`,
    };
  });

  const yes = (t: CanvasIoType) => (used[t] > 0 ? "yes" : "no");
  const frame =
    used.image > 0 &&
    (imageRole === "first_frame" || imageRole === "last_frame");
  return {
    fates,
    derived: {
      input_has_image: yes("image"),
      input_has_video: yes("video"),
      input_has_audio: yes("audio"),
      input_has_frame_control: frame ? "yes" : "no",
    },
  };
}

/**
 * 节点还没有产物时，主视觉占位按哪个宽高比（宽 / 高）摆：取档位里的画幅（`16:9` / `16x9`），
 * 自适应（`auto` / `adaptive`）或没有画幅这一维时按 16:9。
 * 极端比例（如 1:8）夹到 1:2 ～ 4:1：占位只是预告形状，一张 2000px 高的空卡没有意义。
 */
export function placeholderAspect(value: string | undefined): number {
  const m = value?.match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/);
  const ratio = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
  return Number.isFinite(ratio) && ratio > 0
    ? Math.min(Math.max(ratio, 1 / 2), 4)
    : 16 / 9;
}

/** 收窄后的档位 + 此刻的联动限制（面板据此置灰） */
export interface ResolvedParams {
  /** 实际会提交的取值（可选维度没选 = 不在表里） */
  values: Record<string, string>;
  /** 某维度此刻只允许这些取值（没有限制的维度不在表里） */
  allow: Map<string, string[]>;
  /** 此刻不能传的维度 */
  forbid: Set<string>;
}

/** 当前取值 + derived 下命中的规则汇总 */
function hits(
  model: AigcModel,
  current: Record<string, string>,
): { allow: Map<string, string[]>; forbid: Set<string> } {
  const allow = new Map<string, string[]>();
  const forbid = new Set<string>();
  for (const rule of model.constraints ?? []) {
    const hit = Object.entries(rule.when).every(([dim, values]) => {
      const v = current[dim];
      // 没有当前值的维度不参与命中（不传它时，引用它的规则不会命中）
      return v !== undefined && values.includes(v);
    });
    if (!hit) continue;
    for (const dim of rule.forbid ?? []) forbid.add(dim);
    for (const [dim, values] of Object.entries(rule.allow ?? {})) {
      const prev = allow.get(dim);
      allow.set(dim, prev ? prev.filter((v) => values.includes(v)) : [...values]);
    }
  }
  return { allow, forbid };
}

/**
 * 把请求的档位收窄成「这个模型此刻真能接受」的一份（后端 sanitizeParams 的镜像）：
 * 丢无效维度 → 必填缺值补第一个 → 套 constraints（forbid 删维度、allow 取交集，
 * 当前值不在交集里换成交集第一个），循环到稳定。
 */
export function resolveParams(
  model: AigcModel,
  requested: Record<string, string>,
  derived: Record<string, string>,
): ResolvedParams {
  const dims = orderedParams(model);
  const chosen: Record<string, string> = {};
  for (const p of dims) {
    const value = requested[p.param_type];
    if (p.options.some((o) => o.value === value)) chosen[p.param_type] = value;
    else if (p.input === "required") chosen[p.param_type] = p.options[0].value;
  }

  for (let pass = 0; pass < 3; pass++) {
    const { allow, forbid } = hits(model, { ...chosen, ...derived });
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
      if (!has && p.input !== "required") continue;
      chosen[dim] = values[0];
      changed = true;
    }
    if (!changed) break;
  }

  return { values: chosen, ...hits(model, { ...chosen, ...derived }) };
}
