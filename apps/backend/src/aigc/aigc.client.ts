import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  aigcChannelsDataSchema,
  aigcCreateTaskDataSchema,
  aigcEnvelopeSchema,
  aigcTaskSchema,
  type AigcChannel,
  type AigcMediaType,
  type AigcTask,
} from './aigc.types';

/** 单次 HTTP 调用的硬超时：接单/查询都是短请求，生成本身是异步的。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * aigc 生成服务的 HTTP 客户端——整个项目里**唯一**直连 aigc 的地方。
 *
 * 只做三件事：取能力目录、接单、查任务。信封（§2.3）在这里剥掉：`code !== "success"`
 * 一律抛错（错误码含义见文档 §3），业务层拿到的都是已解析的强类型 data。
 * env 懒读（与原 GoogleMediaClient 一致）：模块加载期不要求配置存在，测试可临时覆盖。
 */
@Injectable()
export class AigcClient {
  private readonly logger = new Logger(AigcClient.name);

  private baseUrl(): string {
    const url = process.env.AIGC_BASE_URL;
    if (!url) throw new Error('缺少 AIGC_BASE_URL 环境变量');
    return url.replace(/\/+$/, '');
  }

  private token(): string {
    const token = process.env.AIGC_TOKEN;
    if (!token) throw new Error('缺少 AIGC_TOKEN 环境变量');
    return token;
  }

  /** 能力目录（§7）：某类型下按渠道分组的启用模型。 */
  async listChannels(type: AigcMediaType): Promise<AigcChannel[]> {
    const data = await this.call('GET', `/channels?type=${type}`);
    return aigcChannelsDataSchema.parse(data).channels;
  }

  /** 接单（§5）：同步返回 task_id，生成异步进行。 */
  async createTask(
    path: string,
    body: Record<string, unknown>,
    traceId?: string,
  ): Promise<{ taskId: string; status: string }> {
    const data = await this.call('POST', path, body, traceId);
    const parsed = aigcCreateTaskDataSchema.parse(data);
    return { taskId: parsed.task_id, status: parsed.status ?? 'pending' };
  }

  /** 查任务详情（§6.1）：回调没到时的对账手段。 */
  async getTask(taskId: string): Promise<AigcTask> {
    const data = await this.call('GET', `/tasks/${taskId}`);
    return aigcTaskSchema.parse(data);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    traceId?: string,
  ): Promise<unknown> {
    const trace = traceId ?? randomUUID();
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        'Content-Type': 'application/json',
        'X-Trace-Id': trace,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 5xx / 网关错误可能回纯文本或 HTML，先按文本读再试解析，避免 "Unexpected token" 这种晦涩报错
    const text = await res.text();
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(
        `aigc ${method} ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`,
      );
    }
    const parsed = aigcEnvelopeSchema.parse(envelope);
    if (parsed.code !== 'success') {
      // data 里带 reason / violations 等定位信息（§3.3），排查时比 message 有用得多
      const detail = parsed.data
        ? ` detail=${JSON.stringify(parsed.data)}`
        : '';
      this.logger.warn(
        `aigc ${method} ${path} 失败 code=${parsed.code} trace=${trace}${detail}`,
      );
      throw new Error(
        `aigc ${parsed.code}: ${parsed.message ?? 'request failed'}${detail}`,
      );
    }
    return parsed.data;
  }
}
