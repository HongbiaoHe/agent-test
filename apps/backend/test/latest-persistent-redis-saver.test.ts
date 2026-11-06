/**
 * LatestPersistentRedisSaver 接真实 LangGraph 图 + 真实 Redis Stack：
 * 最新 checkpoint（及其 writes）不过期、被取代的旧版本全部带 TTL、审批中断能续跑、deleteThread 照常清干净。
 *
 * 需要一个可随意清空的 Redis Stack（别指向开发库），例如：
 *   docker run -d --rm --name ckpt-test-redis -p 6390:6379 redis/redis-stack-server:latest
 *   REDIS_TEST_URL=redis://localhost:6390 pnpm --filter backend test:deepagents
 * 没设 REDIS_TEST_URL 时整组跳过。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import { createClient, type RedisClientType } from 'redis';
import { LatestPersistentRedisSaver } from '../src/agent/latest-persistent-redis-saver';

const url = process.env.REDIS_TEST_URL;
const TTL = 120;

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

function buildGraph(saver: LatestPersistentRedisSaver) {
  return new StateGraph(State)
    .addNode('a', () => ({ log: ['a'] }))
    .addNode('b', () => ({ log: ['b'] }))
    .addNode('approve', () => {
      const answer = interrupt<string, string>('ok?');
      return { log: [`approve:${answer}`] };
    })
    .addNode('d', () => ({ log: ['d'] }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', 'approve')
    .addEdge('approve', 'd')
    .addEdge('d', END)
    .compile({ checkpointer: saver });
}

void describe('LatestPersistentRedisSaver', { skip: !url }, () => {
  let saver: LatestPersistentRedisSaver;
  let probe: RedisClientType;

  before(async () => {
    saver = await LatestPersistentRedisSaver.connect(url!, TTL);
    probe = createClient({ url });
    await probe.connect();
  });
  after(async () => {
    await saver.end();
    await probe.quit();
  });

  /** thread 下所有 key → TTL；并找出最新 checkpoint id（id 是时间有序的 uuid6，取字典序最大）。 */
  async function snapshot(threadId: string) {
    const keys = await probe.keys(`*:${threadId}:*`);
    const ttl = new Map<string, number>();
    for (const k of keys) ttl.set(k, await probe.ttl(k));
    const latest = keys
      .filter((k) => k.startsWith(`checkpoint:${threadId}::`))
      .map((k) => k.split(':')[3])
      .sort()
      .at(-1)!;
    return { keys, ttl, latest };
  }

  void it('最新 checkpoint 及其 writes 不过期，其余全部带 TTL；中断后可续跑', async () => {
    const threadId = `ttltest${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };
    const graph = buildGraph(saver);

    await graph.invoke({ log: ['start'] }, config);
    const paused = await graph.getState(config);
    assert.deepEqual(paused.next, ['approve'], '应停在审批节点');
    assert.equal(paused.tasks[0]?.interrupts.length, 1, '应有一个待处理中断');

    let s = await snapshot(threadId);
    const checkpointsBefore = s.keys.filter((k) =>
      k.startsWith('checkpoint:'),
    ).length;
    assert.ok(
      checkpointsBefore >= 4,
      `应产生多份 checkpoint，实际 ${checkpointsBefore}`,
    );
    for (const [k, t] of s.ttl) {
      const isLatest = k.includes(`:${s.latest}`);
      if (isLatest)
        assert.equal(t, -1, `最新 checkpoint 相关 key 不应过期: ${k}`);
      else
        assert.ok(
          t > 0 && t <= TTL,
          `旧 key 应带 TTL(<=${TTL})，实际 ${t}: ${k}`,
        );
    }

    const done = await graph.invoke(new Command({ resume: 'yes' }), config);
    assert.deepEqual(done.log, ['start', 'a', 'b', 'approve:yes', 'd']);

    s = await snapshot(threadId);
    const persistent = [...s.ttl].filter(([, t]) => t === -1).map(([k]) => k);
    assert.ok(persistent.length > 0, '续跑后最新 checkpoint 仍应存在');
    for (const k of persistent) {
      assert.ok(
        k.includes(`:${s.latest}`),
        `只有最新 checkpoint 的 key 可以不过期: ${k}`,
      );
    }
    for (const [k, t] of s.ttl) {
      if (!k.includes(`:${s.latest}`))
        assert.ok(t > 0, `旧 key 应带 TTL: ${k}`);
    }

    // 最新那份单独就能读：getState 不依赖已过期/将过期的历史
    const final = await graph.getState(config);
    assert.deepEqual(final.next, []);

    await saver.deleteThread(threadId);
    assert.equal(
      (await probe.keys(`*:${threadId}:*`)).length,
      0,
      'deleteThread 应清干净',
    );
  });
});
