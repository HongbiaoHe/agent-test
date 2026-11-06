import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';
import { createClient, type RedisClientType } from 'redis';

/** 被新 checkpoint 取代的旧版本保留多久（秒）。只用于直接翻 redis 排查，业务不读历史。 */
export const HISTORY_TTL_SECONDS = 24 * 3600;

/**
 * 每个 thread（及子图 namespace）的最新 checkpoint 永久保留；被新 checkpoint 取代的上一份，
 * 连同它的 pending writes，设 HISTORY_TTL_SECONDS 过期。
 *
 * 为什么不需要历史：RedisSaver 每份 checkpoint 只存本步变化的 channel、读取时也不沿父链回拼
 * （@langchain/langgraph-checkpoint-redis 1.0.6 dist/index.js put/getTuple），业务只调 getState
 * 读最新一份；之前每个会话最多攒了 1000+ 份历史、整库 6G。
 *
 * 父 fromUrl 返回的是父类实例且 client 是 private，所以自己建连接、自己持有一份 client 引用。
 */
export class LatestPersistentRedisSaver extends RedisSaver {
  constructor(
    private readonly redis: RedisClientType,
    private readonly historyTtlSeconds = HISTORY_TTL_SECONDS,
  ) {
    super(redis);
  }

  static async connect(url: string, historyTtlSeconds?: number) {
    const client = createClient({ url }) as RedisClientType;
    await client.connect();
    return new LatestPersistentRedisSaver(client, historyTtlSeconds);
  }

  override async put(...args: Parameters<RedisSaver['put']>) {
    const [config] = args;
    const next = await super.put(...args);
    const conf = config.configurable ?? {};
    const parentId = conf.checkpoint_id as string | undefined;
    if (parentId && parentId !== next.configurable?.checkpoint_id) {
      await this.expireCheckpoint(
        conf.thread_id as string,
        (conf.checkpoint_ns as string | undefined) ?? '',
        parentId,
      );
    }
    return next;
  }

  /**
   * 迟到的 writes：审批续跑时，LangGraph 会在下一份 checkpoint 已经 put 之后，才把中断那步
   * 任务的 writes 补写到旧 checkpoint 名下（集成测试实测）。目标 checkpoint 已带 TTL（=已被取代）
   * 就给它的 writes 一并补上过期；先写后查，与 put 里的 expire 无论谁先都不会漏。
   */
  override async putWrites(...args: Parameters<RedisSaver['putWrites']>) {
    await super.putWrites(...args);
    const conf = args[0].configurable ?? {};
    const threadId = conf.thread_id as string;
    const ns = (conf.checkpoint_ns as string | undefined) ?? '';
    const id = conf.checkpoint_id as string;
    if ((await this.redis.ttl(`checkpoint:${threadId}:${ns}:${id}`)) > 0) {
      await this.expireCheckpoint(threadId, ns, id);
    }
  }

  private async expireCheckpoint(threadId: string, ns: string, id: string) {
    const zsetKey = `write_keys_zset:${threadId}:${ns}:${id}`;
    const writeKeys = await this.redis.zRange(zsetKey, 0, -1);
    const keys = [`checkpoint:${threadId}:${ns}:${id}`, zsetKey, ...writeKeys];
    await Promise.all(
      keys.map((k) => this.redis.expire(k, this.historyTtlSeconds)),
    );
  }
}
