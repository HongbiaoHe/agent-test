import type { BackgroundTask } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { StreamService } from '../events/stream.service';
import { McpAuthRequiredError, type McpService } from '../mcp/mcp.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import { BackgroundService } from './background.service';

// 真实模块会经沙箱提供方链路引入 ESM 依赖（p-retry），ts-jest 解析不了；这里只需要类型
jest.mock('../sandbox/sandbox-settings.service', () => ({
  SandboxSettingsService: class {},
}));
jest.mock('../agent/sandbox', () => ({
  findUserSandbox: jest.fn(),
  keepUserSandboxAlive: jest.fn().mockResolvedValue(undefined),
}));
import { findUserSandbox, keepUserSandboxAlive } from '../agent/sandbox';

type Where = Record<string, unknown>;

/** 只实现 BackgroundService 用到的那几个 Prisma 调用的内存版。 */
function fakeDb(convStatus = 'done') {
  const tasks = new Map<string, BackgroundTask>();
  const conv = { id: 'c1', status: convStatus, deletedAt: null };
  const messages: { role: string; content: unknown; seq: number }[] = [];
  let n = 0;
  const matches = (t: BackgroundTask, w: Where) =>
    Object.entries(w).every(([k, v]) => {
      const cur = (t as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'not' in v) return cur !== v.not;
      if (v && typeof v === 'object' && 'in' in v)
        return (v.in as unknown[]).includes(cur);
      return cur === v;
    });
  const backgroundTask = {
    create: jest.fn(({ data }: { data: Partial<BackgroundTask> }) => {
      const row = {
        id: `t${++n}`,
        status: 'running',
        result: null,
        delivered: false,
        polls: 0,
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        notify: true,
        ...data,
      } as BackgroundTask;
      tasks.set(row.id, row);
      return Promise.resolve(row);
    }),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        [...tasks.values()].filter((t) => matches(t, where)).length,
      ),
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(tasks.get(where.id) ?? null),
    ),
    findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(tasks.get(where.id)),
    ),
    findFirst: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        [...tasks.values()].find((t) => matches(t, where)) ?? null,
      ),
    ),
    findMany: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve([...tasks.values()].filter((t) => matches(t, where))),
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<BackgroundTask>;
      }) => {
        const row = { ...tasks.get(where.id)!, ...data };
        tasks.set(row.id, row);
        return Promise.resolve(row);
      },
    ),
    updateMany: jest.fn(
      ({ where, data }: { where: Where; data: Partial<BackgroundTask> }) => {
        let count = 0;
        for (const t of tasks.values()) {
          if (!matches(t, where)) continue;
          tasks.set(t.id, { ...t, ...data });
          count++;
        }
        return Promise.resolve({ count });
      },
    ),
  };
  const prisma = {
    backgroundTask,
    conversation: {
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { status: { in: string[] } };
          data: { status: string };
        }) => {
          if (!where.status.in.includes(conv.status))
            return Promise.resolve({ count: 0 });
          conv.status = data.status;
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    message: {
      count: jest.fn(() => Promise.resolve(messages.length)),
      create: jest.fn(
        ({
          data,
        }: {
          data: { role: string; content: unknown; seq: number };
        }) => {
          messages.push(data);
          return Promise.resolve(data);
        },
      ),
    },
  };
  return { prisma, tasks, conv, messages };
}

function setup(convStatus = 'done') {
  const db = fakeDb(convStatus);
  const stream = { publish: jest.fn().mockResolvedValue(undefined) };
  const mcp = { callTool: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const agentQueue = { add: jest.fn().mockResolvedValue({}) };
  const settings = { resolve: jest.fn().mockResolvedValue({}) };
  const svc = new BackgroundService(
    db.prisma as unknown as PrismaService,
    stream as unknown as StreamService,
    mcp as unknown as McpService,
    settings as unknown as SandboxSettingsService,
    queue as unknown as Queue,
    agentQueue as unknown as Queue,
  );
  return { svc, db, stream, mcp, queue, agentQueue };
}

const watchSpec = {
  serverId: 's1',
  serverName: 'BuzzVideo',
  toolName: 'get_task',
  modelToolName: 'buzzvideo__get_task',
  args: { taskId: 'x' },
  untilPath: 'status',
  doneValues: ['completed'],
  failValues: ['failed'],
  intervalSec: 10,
  consecutiveErrors: 0,
};

async function createWatch(svc: BackgroundService, timeoutMin = 30) {
  return svc.create({
    conversationId: 'c1',
    userId: 'u1',
    kind: 'watch',
    title: 'Wait',
    spec: watchSpec,
    timeoutMin,
    notify: true,
    firstTickMs: 10_000,
  });
}

describe('BackgroundService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('创建即排第一次 tick，并推送任务卡片', async () => {
    const { svc, queue, stream } = setup();
    const row = await createWatch(svc);
    expect(queue.add).toHaveBeenCalledWith(
      'tick',
      { taskId: row.id },
      expect.objectContaining({ delay: 10_000, jobId: `${row.id}-0` }),
    );
    expect(stream.publish).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ type: 'bg_task_update' }),
    );
  });

  it('watch 未到目标值：轮询次数 +1，按间隔排下一次', async () => {
    const { svc, mcp, queue, db } = setup();
    const row = await createWatch(svc);
    mcp.callTool.mockResolvedValue({
      content: [],
      structuredContent: { status: 'generating' },
    });
    await svc.tick(row.id);
    expect(db.tasks.get(row.id)?.polls).toBe(1);
    expect(queue.add).toHaveBeenLastCalledWith(
      'tick',
      { taskId: row.id },
      expect.objectContaining({ delay: 10_000, jobId: `${row.id}-1` }),
    );
  });

  it('watch 命中：结束为 succeeded，会话空闲 → 写通知消息并唤醒 agent（只一次）', async () => {
    const { svc, mcp, db, agentQueue, stream } = setup('done');
    const row = await createWatch(svc);
    mcp.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"completed","url":"u"}' }],
    });
    await svc.tick(row.id);
    const t = db.tasks.get(row.id)!;
    expect(t.status).toBe('succeeded');
    // 命中的这次检查也计入次数
    expect(t.polls).toBe(1);
    expect(t.delivered).toBe(true);
    expect(db.conv.status).toBe('queued');
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].role).toBe('user');
    expect(JSON.stringify(db.messages[0].content)).toContain(
      '<task-notification>',
    );
    expect(stream.publish).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ type: 'task_notification' }),
    );
    expect(agentQueue.add).toHaveBeenCalledTimes(1);
    // 再 tick / 再投递都不会重复
    await svc.tick(row.id);
    await svc.deliverPending('c1');
    expect(agentQueue.add).toHaveBeenCalledTimes(1);
  });

  it('会话正忙：通知挂起不投递；本轮结束（done）后 deliverPending 才唤醒', async () => {
    const { svc, mcp, db, agentQueue } = setup('running');
    const row = await createWatch(svc);
    mcp.callTool.mockResolvedValue({
      content: [],
      structuredContent: { status: 'failed' },
    });
    await svc.tick(row.id);
    expect(db.tasks.get(row.id)?.status).toBe('failed');
    expect(db.tasks.get(row.id)?.delivered).toBe(false);
    expect(agentQueue.add).not.toHaveBeenCalled();

    db.conv.status = 'done';
    await svc.deliverPending('c1');
    expect(db.tasks.get(row.id)?.delivered).toBe(true);
    expect(agentQueue.add).toHaveBeenCalledTimes(1);
  });

  it('超过 deadline → timeout', async () => {
    const { svc, db, mcp } = setup();
    const row = await createWatch(svc);
    db.tasks.set(row.id, { ...db.tasks.get(row.id)!, deadlineAt: new Date(0) });
    await svc.tick(row.id);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(db.tasks.get(row.id)?.status).toBe('timeout');
  });

  it('连续出错 3 次判失败；授权失效立即失败', async () => {
    const { svc, db, mcp } = setup('running');
    const row = await createWatch(svc);
    mcp.callTool.mockRejectedValue(new Error('network'));
    await svc.tick(row.id);
    await svc.tick(row.id);
    expect(db.tasks.get(row.id)?.status).toBe('running');
    await svc.tick(row.id);
    expect(db.tasks.get(row.id)?.status).toBe('failed');

    const row2 = await createWatch(svc);
    mcp.callTool.mockRejectedValue(new McpAuthRequiredError('s1', 'BuzzVideo'));
    await svc.tick(row2.id);
    expect(db.tasks.get(row2.id)?.status).toBe('failed');
  });

  it('取消：不通知、不唤醒；会话停止时取消全部在跑任务并 kill 沙箱命令', async () => {
    const { svc, db, agentQueue } = setup('done');
    const execute = jest.fn().mockResolvedValue({ output: 'cancelled' });
    (findUserSandbox as jest.Mock).mockResolvedValue({ execute });
    const w = await createWatch(svc);
    const cmd = await svc.create({
      conversationId: 'c1',
      userId: 'u1',
      kind: 'command',
      title: 'render',
      spec: { command: 'ffmpeg ...' },
      timeoutMin: 60,
      notify: true,
      firstTickMs: 15_000,
    });
    await svc.cancelByConversation('c1');
    expect(db.tasks.get(w.id)?.status).toBe('cancelled');
    expect(db.tasks.get(cmd.id)?.status).toBe('cancelled');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(`.bg/${cmd.id}/pid`),
    );
    expect(agentQueue.add).not.toHaveBeenCalled();
    expect(db.messages).toHaveLength(0);
  });

  it('command：还在跑 → 续命并排下一次；退出码非 0 → failed 带日志尾', async () => {
    const { svc, db, queue } = setup('running');
    const execute = jest.fn().mockResolvedValue({ output: 'RUNNING\n' });
    (findUserSandbox as jest.Mock).mockResolvedValue({ execute });
    const cmd = await svc.create({
      conversationId: 'c1',
      userId: 'u1',
      kind: 'command',
      title: 'render',
      spec: { command: 'x' },
      timeoutMin: 60,
      notify: true,
      firstTickMs: 15_000,
    });
    await svc.tick(cmd.id);
    expect(keepUserSandboxAlive).toHaveBeenCalled();
    expect(queue.add).toHaveBeenLastCalledWith(
      'tick',
      { taskId: cmd.id },
      expect.objectContaining({ delay: 15_000 }),
    );
    execute.mockResolvedValue({ output: 'EXIT:1\nerror: bad input\n' });
    await svc.tick(cmd.id);
    const t = db.tasks.get(cmd.id)!;
    expect(t.status).toBe('failed');
    expect(t.polls).toBe(2);
    expect(JSON.stringify(t.result)).toContain('error: bad input');
  });

  it('wakeup：到点 succeeded，通知里带着备注', async () => {
    const { svc, db } = setup('done');
    const row = await svc.create({
      conversationId: 'c1',
      userId: 'u1',
      kind: 'wakeup',
      title: 'check later',
      spec: { note: 'look at the render queue' },
      timeoutMin: 5,
      notify: true,
      firstTickMs: 300_000,
    });
    await svc.tick(row.id);
    expect(db.tasks.get(row.id)?.status).toBe('succeeded');
    expect(JSON.stringify(db.messages[0].content)).toContain(
      'look at the render queue',
    );
  });

  it('每个会话最多 5 个在跑任务', async () => {
    const { svc } = setup();
    for (let i = 0; i < 5; i++) await createWatch(svc);
    await expect(svc.assertCapacity('c1')).rejects.toThrow(/max 5/);
  });
});
