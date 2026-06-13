import { EventsGateway } from './events.gateway';

const makeSocket = () => ({
  data: { user: { userId: 'u1', tenantId: 't1' } },
  on: jest.fn(),
  emit: jest.fn(),
});

describe('EventsGateway.handleSubscribe', () => {
  it('同一 socket 重复订阅同一会话只启动一个 stream reader', async () => {
    const subscribe = jest.fn();
    const stream = { subscribe } as any;
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
    } as any;
    const gw = new EventsGateway(stream, {} as any, prisma, {} as any);
    const socket = makeSocket() as any;

    // 模拟切换会话再切回：对同一会话连续订阅多次
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('同一 socket 订阅不同会话各启动一个 reader', async () => {
    const subscribe = jest.fn();
    const stream = { subscribe } as any;
    const prisma = {
      conversation: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: any) => ({ id: where.id })),
      },
    } as any;
    const gw = new EventsGateway(stream, {} as any, prisma, {} as any);
    const socket = makeSocket() as any;

    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c2' }, socket);

    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
