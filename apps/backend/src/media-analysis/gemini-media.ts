import { FileState, GoogleGenAI, type Part } from '@google/genai';

/**
 * 用 Gemini 理解一份媒体（图片 / 视频 / 音频），按给定 JSON Schema 返回结构化文本。
 *
 * 小文件内联进请求（inlineData）；大文件先传 Gemini Files API 拿 fileUri 再引用，用完即删。
 * 视频上传后要等服务端处理到 ACTIVE 才能用。
 */

/** 内联上限：留余量给提示词与 JSON 包装（请求整体有大小上限） */
const INLINE_MAX_BYTES = 15 * 1024 * 1024;
const FILE_READY_POLL_MS = 2_000;
const FILE_READY_TIMEOUT_MS = 120_000;

export interface GeminiMediaInput {
  apiKey: string;
  model: string;
  bytes: Buffer;
  mimeType: string;
  prompt: string;
  /** responseJsonSchema：已去掉 $schema 的 JSON Schema */
  jsonSchema: unknown;
  signal?: AbortSignal;
}

export interface GeminiMediaResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function analyzeMediaWithGemini(
  input: GeminiMediaInput,
): Promise<GeminiMediaResult> {
  const ai = new GoogleGenAI({ apiKey: input.apiKey });
  let uploadedName: string | null = null;
  try {
    let media: Part;
    if (input.bytes.length <= INLINE_MAX_BYTES) {
      media = {
        inlineData: {
          mimeType: input.mimeType,
          data: input.bytes.toString('base64'),
        },
      };
    } else {
      const file = await ai.files.upload({
        file: new Blob([new Uint8Array(input.bytes)], {
          type: input.mimeType,
        }),
        config: { mimeType: input.mimeType },
      });
      uploadedName = file.name ?? null;
      const ready = await waitFileActive(ai, file.name ?? '', input.signal);
      media = {
        fileData: { fileUri: ready.uri ?? '', mimeType: input.mimeType },
      };
    }

    const res = await ai.models.generateContent({
      model: input.model,
      contents: [{ role: 'user', parts: [media, { text: input.prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: input.jsonSchema,
        abortSignal: input.signal,
      },
    });
    const text = res.text ?? '';
    if (!text) throw new Error('模型没有返回内容');
    return {
      text,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } finally {
    if (uploadedName) {
      // Files API 的文件 48 小时后也会自动删；这里用完就删，失败无妨
      await ai.files.delete({ name: uploadedName }).catch(() => undefined);
    }
  }
}

async function waitFileActive(
  ai: GoogleGenAI,
  name: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  while (true) {
    if (signal?.aborted) throw new Error('已取消');
    const f = await ai.files.get({ name });
    if (f.state === FileState.ACTIVE) return f;
    if (f.state === FileState.FAILED) throw new Error('Gemini 处理文件失败');
    if (Date.now() >= deadline) throw new Error('Gemini 处理文件超时');
    await new Promise((r) => setTimeout(r, FILE_READY_POLL_MS));
  }
}
