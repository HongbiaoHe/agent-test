/**
 * Web 后端（apps/backend）的 HTTP 客户端：桌面端登录 Web 账号后，生图 / 生视频 / 配音经它的 /media-api 接口
 * 调到 Web 同一个 MediaService。令牌由 main 经 env（SPARK_WEB_TOKEN）注入，只在 agent-host 里使用。
 *
 * 响应信封同 Web：成功 { code: 0, message, data }；业务错误 { code: <错误码>, message }（HTTP 4xx / 5xx）。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

// 错误响应 data 为 null（AllExceptionsFilter：{ code, message, data: null }）
const envelope = z.object({ code: z.number(), message: z.string().optional(), data: z.unknown().optional() });

export class WebApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }

  /** 登录过期 / 令牌无效 */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export class WebApi {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 从 agent-host 的 env 构造；没登录（缺地址或令牌）返回 null */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WebApi | null {
    const url = env.SPARK_WEB_API_URL;
    const token = env.SPARK_WEB_TOKEN;
    return url && token ? new WebApi(url.replace(/\/+$/, ''), token) : null;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body: object): Promise<unknown> {
    return this.request('POST', path, JSON.stringify(body), 'application/json');
  }

  /** 上传本地文件：请求体就是文件二进制（同 Web 的附件上传口径），流式发出不整块读进内存 */
  async upload(path: string, file: string, contentType: string): Promise<unknown> {
    const { size } = await stat(file);
    // 流式 body 必须带 duplex:'half'（undici 要求）；DOM 版 RequestInit 还没有这个字段，用交叉类型补上（同 backend 上传中转）
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': contentType,
        'Content-Length': String(size),
      },
      body: fileStream(file),
      duplex: 'half',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new WebApiError(0, null, `上传到 Web 后端失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return this.parse('POST', path, res);
  }

  private async request(method: string, path: string, body?: string, contentType?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new WebApiError(0, null, `连不上 Web 后端 ${this.baseUrl}：${e instanceof Error ? e.message : String(e)}`);
    }
    return this.parse(method, path, res);
  }

  private async parse(method: string, path: string, res: Response): Promise<unknown> {
    const text = await res.text();
    let parsed: z.infer<typeof envelope> | null = null;
    try {
      const r = envelope.safeParse(JSON.parse(text));
      parsed = r.success ? r.data : null;
    } catch {
      parsed = null;
    }
    if (res.status === 401) {
      throw new WebApiError(401, parsed?.code ?? null, 'Web 账号登录已过期，请在 Spark 设置里重新登录');
    }
    if (!parsed) {
      throw new WebApiError(res.status, null, `Web 后端 ${method} ${path} 返回无法识别的响应（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (parsed.code !== 0) {
      throw new WebApiError(res.status, parsed.code, parsed.message ?? `请求失败（${parsed.code}）`);
    }
    return parsed.data;
  }
}

/** 本地文件 → fetch 能吃的 Web ReadableStream（按需拉取；同 backend media-upload.service 的 toWebStream） */
function fileStream(file: string): ReadableStream<Uint8Array> {
  const src = createReadStream(file);
  const it = chunks(src);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      src.destroy();
    },
  });
}

/** fs 读流产出的都是 Buffer（Uint8Array 子类），借 instanceof 收窄 */
async function* chunks(src: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  for await (const c of src) if (c instanceof Uint8Array) yield c;
}
