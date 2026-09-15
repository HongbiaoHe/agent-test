/**
 * 「思考深度」档位与各家模型参数的映射（纯逻辑，独立文件便于在 jest 里单测；
 * 同 canvas-state-injection.ts / history-window.ts）。
 *
 * 两家能力**不对等**，这是实测结论、不是猜的：
 *
 * - DeepSeek 只有开/关两态。`thinking: { type: 'disabled' }` 稳定生效（3/3 采样思考量为 0）；
 *   而 OpenAI 风格的 `reasoningEffort` 对 deepseek flash **无效** —— 3 次采样 low 平均 3510
 *   字符、high 平均 2700 字符，方向相反且区间大量重叠，纯属模型输出随机波动。所以绝不要给
 *   DeepSeek 暴露 low/medium/high：那是点了没反应的假选项。
 * - Gemini 分级 `thinkingConfig.thinkingLevel` = LOW | MEDIUM | HIGH 全模型可用；但**关闭**
 *   （`thinkingBudget: 0`）逐模型不同 —— 实测矩阵：
 *
 *     模型                      budget0   LOW/MEDIUM/HIGH
 *     gemini-3.1-pro-preview    400       ok
 *     gemini-3.1-flash-lite     ok        ok
 *     gemini-3.5-flash          ok        ok
 *     gemini-3.5-flash-lite     400       ok
 *     gemini-3.6-flash          400       ok
 *     gemini-3-flash-preview    ok        ok
 *     （gemini-3-pro-preview 恒 404，已从白名单移除）
 *
 *   所以「关闭」只对下面这张白名单里的模型开放。用白名单而不是黑名单：新模型进来时默认不给
 *   off 档，最差是少个选项，而不是整轮跑挂在 400 Bad Request。
 *
 * `includeThoughts` 只决定思考内容是否随响应返回，不改变模型是否思考、也不改变计费。
 * ⚠️ 但实测 @langchain/google-genai 2.1.31 **并不把 Gemini 的 thought 内容暴露出来**：开着
 * includeThoughts 流式跑，content 只有 string 块、没有 thought 块，additional_kwargs 里只有
 * `__gemini_function_call_thought_signatures__`（签名，非正文）。也就是说思考过程面板在 Gemini
 * 上目前是空的（DeepSeek 才有内容）。参数仍然照传，等上游支持后即可自动生效。
 */

/** 实测接受 `thinkingBudget: 0` 的 Gemini 模型；不在表里的传 0 会 400。 */
const GEMINI_CAN_DISABLE_THINKING = new Set([
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
]);

/** 去掉 provider 前缀，拿裸模型名（白名单里既有 `gemini-*` 也有 `google-genai:gemini-*`）。 */
function bareModelName(model: string): string {
  const i = model.indexOf(':');
  return i === -1 ? model : model.slice(i + 1);
}

/** 思考深度档位。auto = 不传任何参数，完全跟随模型默认。 */
export const CANVAS_THINKING_LEVELS = [
  'auto',
  'off',
  'on',
  'low',
  'medium',
  'high',
] as const;

export type CanvasThinkingLevel = (typeof CANVAS_THINKING_LEVELS)[number];

/** DeepSeek 走 `deepseek:` 前缀；其余（含裸 `gemini-*`）按 google-genai 处理，与 factory 的解析一致。 */
function isDeepSeek(model: string): boolean {
  return model.startsWith('deepseek:');
}

/**
 * 该模型真正支持的档位（前端据此渲染可选项，后端据此做回落）。
 * 顺序即 UI 展示顺序。
 */
export function thinkingLevelsFor(model: string): CanvasThinkingLevel[] {
  if (isDeepSeek(model)) return ['auto', 'off', 'on'];
  // Gemini：分级全模型可用，off 只给实测支持关闭的那几个
  return GEMINI_CAN_DISABLE_THINKING.has(bareModelName(model))
    ? ['auto', 'off', 'low', 'medium', 'high']
    : ['auto', 'low', 'medium', 'high'];
}

/** 档位在该模型上是否有效。 */
export function supportsThinkingLevel(
  model: string,
  level: CanvasThinkingLevel,
): boolean {
  return thinkingLevelsFor(model).includes(level);
}

/**
 * 档位 → 传给 initChatModel 的模型参数。
 *
 * 该模型不支持的档位一律按 auto 处理（不抛错）：会话里可能存着换模型之前选的档位，
 * 静默回落比让整轮跑挂掉更合适。
 */
export function thinkingModelParams(
  model: string,
  level: CanvasThinkingLevel | null | undefined,
): Record<string, unknown> {
  const lv = level && supportsThinkingLevel(model, level) ? level : 'auto';

  if (isDeepSeek(model)) {
    if (lv === 'off') {
      return { modelKwargs: { thinking: { type: 'disabled' } } };
    }
    if (lv === 'on') {
      return { modelKwargs: { thinking: { type: 'enabled' } } };
    }
    return {};
  }

  if (lv === 'off') return { thinkingConfig: { thinkingBudget: 0 } };
  if (lv === 'low') {
    return { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } };
  }
  if (lv === 'medium') {
    return {
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
    };
  }
  if (lv === 'high') {
    return { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } };
  }
  // auto：不定档位，但仍要让思考内容可见（见文件头注释）
  return { thinkingConfig: { includeThoughts: true } };
}
