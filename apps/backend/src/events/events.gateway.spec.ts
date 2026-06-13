import { JwtService } from '@nestjs/jwt';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from './stream.service';
import { EventsGateway } from './events.gateway';

type SubscribeSocket = Parameters<EventsGateway['handleSubscribe']>[1];

const makeSocket = () => ({
  data: { user: { userId: 'u1', tenantId: 't1' } },
  on: jest.fn(),
  emit: jest.fn(),
});

describe('EventsGateway.handleSubscribe', () => {
  it('同一 socket 重复订阅同一会话只启动一个 stream reader', async () => {
    const subscribe = jest.fn();
    const stream = { subscribe } as unknown as StreamService;
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
    } as unknown as PrismaService;
    const gw = new EventsGateway(
      stream,
      {} as unknown as Queue,
      prisma,
      {} as unknown as JwtService,
    );
    const socket = makeSocket() as unknown as SubscribeSocket;

    // 模拟切换会话再切回：对同一会话连续订阅多次
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c1' }, socket);

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('同一 socket 订阅不同会话各启动一个 reader', async () => {
    const subscribe = jest.fn();
    const stream = { subscribe } as unknown as StreamService;
    const prisma = {
      conversation: {
        findFirst: jest
          .fn()
          .mockImplementation((args: { where: { id: string } }) => ({
            id: args.where.id,
          })),
      },
    } as unknown as PrismaService;
    const gw = new EventsGateway(
      stream,
      {} as unknown as Queue,
      prisma,
      {} as unknown as JwtService,
    );
    const socket = makeSocket() as unknown as SubscribeSocket;

    await gw.handleSubscribe({ conversationId: 'c1' }, socket);
    await gw.handleSubscribe({ conversationId: 'c2' }, socket);

    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
