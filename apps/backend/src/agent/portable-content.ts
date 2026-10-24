import {
  AIMessage,
  isAIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';

/**
 * 跨 provider 续聊时，历史消息里 provider 私有内容块的净化。
 *
 * 症状：会话前几轮用 Gemini 跑过、之后切到 DeepSeek，下一轮直接 400：
 *   `Failed to deserialize the JSON body: messages[3]: unknown variant 'thinking',
 *    expected one of 'text', 'image_url', 'file'`
 * 剥掉 thinking 之后换成 `unknown variant 'functionCall'` —— 同一堵墙的另一块砖。
 *
 * 原因：这些块不在我们自己的历史重放里（loadHistory 只取 message/tool_end，且 content 是纯字符串），
 * 而是 **checkpointer 恢复的 state**——Gemini 那几轮的 AIMessage.content 是内容块数组，里面既有
 * `{ type: 'thinking' }` 也有 `{ type: 'functionCall' }` 这类 Gemini 原生块。这份 state 原样交给
 * 下一轮的模型，OpenAI 兼容端的请求体 schema 里没有这些 variant，反序列化直接失败。
 * 会话一旦换过模型就再也跑不动，且换回去也不自愈（坏块永久留在 checkpoint 里）。
 *
 * 处理：**按白名单**而不是黑名单——报错自己给出了对端接受的全集（text / image_url / file），
 * 其余一律剥掉。黑名单每遇到一种新块就要补一次，白名单一次到位。
 * 只改发给模型的那一份（wrapModelCall 不写回 state），checkpoint 与前端展示的思考过程都不受影响。
 *
 * 工具结果同理（2026-10-24 Spark 实测）：deepagents 的 read_file 读图片时返回标准内容块
 * `{ type: 'image', mimeType, data }`，DeepSeek 端报 `unknown variant 'image'`，且这条 ToolMessage
 * 存进 checkpoint 后每轮重放、会话永久跑不动。工具结果里的非白名单块换成一句文字占位
 * （而不是直接剥掉）：模型得知道「读到的是张图、只是看不了」，否则会以为文件是空的。
 */

/** OpenAI 兼容端在消息内容里接受的块类型（取自它自己的报错：expected one of …）。 */
const PORTABLE_TYPES = new Set(['text', 'image_url', 'file']);

/**
 * 该模型能否原样收下历史里的 provider 原生内容块。
 *
 * 只有 Gemini 能——那些块本来就是它自己产的，且思考块带 thoughtSignature，
 * 多轮函数调用必须原样回传，剥掉等于让模型丢失上一轮的思考签名。
 *
 * 判据同 resolveChatModel：不带 `provider:` 前缀的裸名默认走 google-genai。
 */
export function keepsNativeBlocks(model: string): boolean {
  return !model.includes(':') || model.startsWith('google-genai:');
}

function isPortableBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null || !('type' in block)) {
    return false;
  }
  const { type } = block;
  return typeof type === 'string' && PORTABLE_TYPES.has(type);
}

/**
 * 只保留 AI 消息内容里对端认得的块。
 *
 * 工具调用本身不受影响——它在 message.tool_calls 上，由各家适配器自己序列化；
 * content 里那份 `functionCall` 块是 Gemini 的原生副本，剥掉不丢信息。
 *
 * 不改原消息（那是 checkpoint 恢复出来的 state 对象）；没有杂块的消息原样返回同一个对象，
 * 少建一批对象，也让 prompt cache 的前缀保持逐字稳定。
 * 剥完为空时退回空字符串而不是空数组：带 tool_calls、正文只有思考的那种消息，
 * 留一个空数组反而更容易在各家的 schema 校验上翻车。
 */
export function stripNonPortableBlocks(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (ToolMessage.isInstance(m)) return placeholderToolBlocks(m);
    if (!isAIMessage(m) || !Array.isArray(m.content)) return m;
    const kept = m.content.filter(isPortableBlock);
    if (kept.length === m.content.length) return m;
    return new AIMessage({ ...m, content: kept.length > 0 ? kept : '' });
  });
}

/** 一个对端认不得的块换成的文字说明（图片带上 MIME，让模型知道读到的是什么）。 */
function placeholderText(block: unknown): string {
  const type =
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    typeof block.type === 'string'
      ? block.type
      : 'unknown';
  if (type === 'image') {
    const mime =
      typeof block === 'object' &&
      block !== null &&
      'mimeType' in block &&
      typeof block.mimeType === 'string'
        ? block.mimeType
        : 'image';
    return `[工具返回了一张图片（${mime}），当前模型无法查看图片，已省略图片内容]`;
  }
  return `[工具返回了 ${type} 类型的内容，当前模型无法处理，已省略]`;
}

/**
 * 工具结果里的非白名单块换成文字占位。全部变成文字时合并成一个字符串：
 * 部分 OpenAI 兼容端对 tool 消息只认字符串 content，字符串最稳。
 * 没有杂块的原样返回同一个对象（同 AI 消息的处理，保持前缀稳定）。
 */
function placeholderToolBlocks(m: ToolMessage): BaseMessage {
  if (!Array.isArray(m.content) || m.content.every(isPortableBlock)) return m;
  const blocks = m.content.map((b) =>
    isPortableBlock(b)
      ? b
      : { type: 'text' as const, text: placeholderText(b) },
  );
  const texts = blocks.flatMap((b) =>
    b.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
  );
  return new ToolMessage({
    ...m,
    content: texts.length === blocks.length ? texts.join('\n') : blocks,
  });
}
