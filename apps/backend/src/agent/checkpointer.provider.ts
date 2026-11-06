import { Provider } from '@nestjs/common';
import { LatestPersistentRedisSaver } from './latest-persistent-redis-saver';

export const CHECKPOINTER = 'CHECKPOINTER';

/**
 * RedisSaver 单例（需 Redis Stack 的 RediSearch/RedisJSON 模块）。
 * 是 interruptOn 审批中断与 resume 续跑的持久化基础。
 * 最新 checkpoint 永久保留，旧版本过期（见 LatestPersistentRedisSaver）。
 */
export const checkpointerProvider: Provider = {
  provide: CHECKPOINTER,
  useFactory: async () => {
    const saver = await LatestPersistentRedisSaver.connect(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
    );
    const maybe = saver as { setup?: () => Promise<void> };
    if (typeof maybe.setup === 'function') await maybe.setup();
    return saver;
  },
};
