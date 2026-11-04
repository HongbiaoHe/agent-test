import {
  type BaseMessage,
  HumanMessage,
  isToolMessage,
} from '@langchain/core/messages';

/**
 * render_preview / inspect_layers 的图怎么交给模型看。
 *
 * 不能直接作为工具结果的图片块返回：@langchain/google-genai 把 ToolMessage 转成 functionResponse，
 * 图片块被当文本序列化，整张 PNG 的 base64 按字符计 token——2026-11-03 实测一次预览就
 * 「input token count exceeds the maximum number of tokens allowed 1048576」，整轮失败。
 *
 * 所以工具只回文字，图放在 ToolMessage.artifact（artifact 不发给模型）；本中间件在下一次调模型前
 * 把它补成一条带图片的用户消息（Gemini 对 user 消息里的 inline 图片是真正按图像理解的）。
 * 走 beforeModel 而不是 wrapModelCall：消息经 reducer 落进 state，前缀 append-only，不破坏缓存
 * （理由同 canvas-state-injection.ts）。用固定 id 去重，同一张预览只补一次。
 */

export const PREVIEW_TOOL = 'render_preview';
export const INSPECT_TOOL = 'inspect_layers';

/** 会带图的工具 → 补成用户消息时配的说明 */
const IMAGE_TOOLS: Record<string, string> = {
  [PREVIEW_TOOL]:
    '（这是 render_preview 刚渲染出的当前版面，请据此自检并调整）',
  [INSPECT_TOOL]:
    '（这是 inspect_layers 拼出的图层总览：每格一个图层，标签是图层 id，灰底只为看清透明图层）',
};

export interface PreviewArtifact {
  previewPng: string;
}

function previewOf(artifact: unknown): string | null {
  return artifact &&
    typeof artifact === 'object' &&
    'previewPng' in artifact &&
    typeof artifact.previewPng === 'string'
    ? artifact.previewPng
    : null;
}

export function buildPreviewInjection(state: {
  messages: BaseMessage[];
}): { messages: BaseMessage[] } | undefined {
  const existing = new Set(state.messages.map((m) => m.id));
  const add: BaseMessage[] = [];
  for (const m of state.messages) {
    if (!isToolMessage(m) || !m.name || !(m.name in IMAGE_TOOLS)) continue;
    const png = previewOf(m.artifact);
    const id = `design-preview-${m.tool_call_id}`;
    if (!png || existing.has(id)) continue;
    add.push(
      new HumanMessage({
        id,
        content: [
          {
            type: 'text',
            text: IMAGE_TOOLS[m.name],
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${png}` },
          },
        ],
      }),
    );
  }
  return add.length ? { messages: add } : undefined;
}
