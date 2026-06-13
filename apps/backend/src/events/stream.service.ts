import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RawEvent } from '../agent/event-normalizer';
import { ConversationEvent } from '../agent/types';

/** 负责把事件写入 Redis Stream，以及从 Stream 持续读取转发。 */
@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(conversationId: string) {
    return `conversation:${conversationId}:events`;
  }

  /** XADD 一条事件（MAXLEN 限长，seq 由 Redis 生成）。 */
  async publish(conversationId: string, raw: RawEvent): Promise<void> {
    const data = JSON.stringify({
      type: raw.type,
      payload: raw.payload,
      ts: Date.now(),
    });
    await this.redis.xadd(
      this.key(conversationId),
      'MAXLEN',
      '~',
      1000,
      '*',
      'data',
      data,
    );
  }

  /**
   * 从 fromId 起持续 XREAD（BLOCK），每条事件回调，直到 shouldStop 为真。
   * 用 duplicate 连接，避免阻塞主连接。
   */
  async subscribe(
    conversationId: string,
    onEvent: (evt: ConversationEvent) => void,
    shouldStop: () => boolean,
    fromId = '0',
  ): Promise<void> {
    const sub = this.redis.duplicate();
    let lastId = fromId;
    try {
      while (!shouldStop()) {
        const res = await sub.xread(
          'BLOCK',
          2000,
          'STREAMS',
          this.key(conversationId),
          lastId,
        );
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id;
            const idx = fields.indexOf('data');
            const parsed = (
              idx >= 0 ? JSON.parse(fields[idx + 1]) : {}
            ) as Pick<ConversationEvent, 'type' | 'payload' | 'ts'>;
            onEvent({
              seq: id,
              conversationId,
              type: parsed.type,
              payload: parsed.payload,
              ts: parsed.ts,
            });
          }
        }
      }
    } catch (e) {
      this.logger.warn(
        `stream subscribe(${conversationId}) 结束: ${String(e)}`,
      );
    } finally {
      sub.disconnect();
    }
  }
}
