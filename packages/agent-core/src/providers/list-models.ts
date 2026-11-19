import { z } from 'zod';
import { normalizeBaseUrl } from './build-model';
import type { ListedModel, ProviderConnection } from './types';

/**
 * 「列出模型」：各协议官方的模型列表接口（直接 HTTP，不经 SDK，也用作「测试连接」——不消耗 token）。
 *  - openai / openai-compatible：GET {base}/models（Bearer）
 *  - anthropic：GET {base}/v1/models?limit=1000（x-api-key + anthropic-version，按 after_id 翻页）
 *  - gemini：GET {base}/v1beta/models?pageSize=1000（x-goog-api-key，按 nextPageToken 翻页），
 *    只留 supportedGenerationMethods 含 generateContent 的（embedding 等不能对话）
 */

/** 接口失败：带上 HTTP 状态与服务端原文（截断），界面原样展示 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${body ? `：${body}` : ''}`);
    this.name = 'ProviderHttpError';
  }
}

const MAX_ERROR_BODY = 500;
const MAX_PAGES = 20;
const ANTHROPIC_VERSION = '2023-06-01';

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderHttpError(
      res.status,
      text.trim().slice(0, MAX_ERROR_BODY),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderHttpError(
      res.status,
      `返回的不是 JSON：${text.slice(0, MAX_ERROR_BODY)}`,
    );
  }
}

const openAiList = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().optional(),
        // OpenRouter 扩展字段
        context_length: z.number().nullable().optional(),
      })
      .loose(),
  ),
});

const anthropicList = z.object({
  data: z.array(
    z.object({ id: z.string(), display_name: z.string().optional() }).loose(),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

const geminiList = z.object({
  models: z
    .array(
      z
        .object({
          name: z.string(),
          displayName: z.string().optional(),
          inputTokenLimit: z.number().optional(),
          supportedGenerationMethods: z.array(z.string()).optional(),
          thinking: z.boolean().optional(),
        })
        .loose(),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderHttpError(
      200,
      `模型列表格式不认识：${parsed.error.message.slice(0, MAX_ERROR_BODY)}`,
    );
  }
  return parsed.data;
}

async function listOpenAi(
  conn: ProviderConnection,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const headers: Record<string, string> = {};
  if (conn.apiKey?.trim())
    headers.Authorization = `Bearer ${conn.apiKey.trim()}`;
  const body = parse(
    openAiList,
    await getJson(`${normalizeBaseUrl(conn.baseUrl)}/models`, headers, signal),
  );
  return body.data.map((m) => ({
    id: m.id,
    displayName: m.name && m.name !== m.id ? m.name : null,
    contextWindow: m.context_length ?? null,
    thinking: null,
  }));
}

async function listAnthropic(
  conn: ProviderConnection,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const base = normalizeBaseUrl(conn.baseUrl);
  const headers = {
    'x-api-key': conn.apiKey?.trim() ?? '',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const out: ListedModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const body: z.infer<typeof anthropicList> = parse(
      anthropicList,
      await getJson(url, headers, signal),
    );
    for (const m of body.data) {
      out.push({
        id: m.id,
        displayName: m.display_name ?? null,
        contextWindow: null,
        thinking: null,
      });
    }
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return out;
}

async function listGemini(
  conn: ProviderConnection,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const base = normalizeBaseUrl(conn.baseUrl);
  const headers = { 'x-goog-api-key': conn.apiKey?.trim() ?? '' };
  const out: ListedModel[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const body: z.infer<typeof geminiList> = parse(
      geminiList,
      await getJson(url, headers, signal),
    );
    for (const m of body.models ?? []) {
      if (!(m.supportedGenerationMethods ?? []).includes('generateContent'))
        continue;
      out.push({
        id: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? null,
        contextWindow: m.inputTokenLimit ?? null,
        thinking: m.thinking ?? null,
      });
    }
    if (!body.nextPageToken) break;
    token = body.nextPageToken;
  }
  return out;
}

/** 列出连接上可用的模型（按 id 排序、去重） */
export async function listModels(
  conn: ProviderConnection,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const models =
    conn.protocol === 'anthropic'
      ? await listAnthropic(conn, signal)
      : conn.protocol === 'gemini'
        ? await listGemini(conn, signal)
        : await listOpenAi(conn, signal);
  const seen = new Set<string>();
  return models
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
