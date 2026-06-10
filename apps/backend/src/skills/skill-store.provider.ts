import { InMemoryStore } from '@langchain/langgraph';

/**
 * 进程级 InMemoryStore 单例：磁盘+DB 才是 source of truth，worker 每 run 前 diff 播种重建；
 * 多实例部署不需要跨进程失效通知（每个进程各自 diff 同步），内存只是当前进程的快速查询层。
 */
export const SKILLS_STORE = Symbol('SKILLS_STORE');
export const skillsStoreProvider = {
  provide: SKILLS_STORE,
  useValue: new InMemoryStore(),
};
