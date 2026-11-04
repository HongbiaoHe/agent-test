import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AbortRegistry } from '../../agent/abort-registry';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCodes } from '../../common/errors/error-code';
import { StreamService } from '../../events/stream.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DesignService } from '../design.service';
import type { DesignUserMessage } from './design-message';

export const DESIGN_RUN_QUEUE = 'design-run';
export const DESIGN_ABORTS = Symbol('DESIGN_ABORTS');

export interface DesignRunJob {
  docId: string;
}

/** 设计 agent 的对话入口：落用户消息 → 置 running → 入队；以及停止。 */
@Injectable()
export class DesignAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly design: DesignService,
    private readonly stream: StreamService,
    @InjectQueue(DESIGN_RUN_QUEUE) private readonly queue: Queue<DesignRunJob>,
    @Inject(DESIGN_ABORTS) private readonly aborts: AbortRegistry,
  ) {}

  async send(
    docId: string,
    tenantId: string,
    message: DesignUserMessage,
    model?: string,
  ): Promise<{ ok: true }> {
    await this.design.findOwned(docId, tenantId);
    // CAS：同一时刻只跑一轮
    const cas = await this.prisma.designDoc.updateMany({
      where: { id: docId, status: { not: 'running' } },
      data: { status: 'running', ...(model ? { model } : {}) },
    });
    if (cas.count === 0) {
      throw new BusinessException(ErrorCodes.DESIGN_BUSY, HttpStatus.CONFLICT);
    }
    const seq = await this.prisma.designMessage.count({ where: { docId } });
    const row = await this.prisma.designMessage.create({
      data: { docId, role: 'user', type: 'message', content: message, seq },
    });
    await this.stream.publish(docId, {
      type: 'message',
      payload: { role: 'user', id: row.id, ...message },
    });
    await this.stream.publish(docId, {
      type: 'design_status',
      payload: { status: 'running' },
    });
    await this.queue.add('run', { docId });
    return { ok: true };
  }

  async stop(docId: string, tenantId: string): Promise<{ stopped: boolean }> {
    await this.design.findOwned(docId, tenantId);
    const stopped = this.aborts.abort(docId);
    if (!stopped) {
      // 不在跑（排队中或进程重启遗留的 running）：直接收尾成 stopped
      const cas = await this.prisma.designDoc.updateMany({
        where: { id: docId, status: 'running' },
        data: { status: 'stopped' },
      });
      if (cas.count > 0) {
        await this.stream.publish(docId, {
          type: 'design_status',
          payload: { status: 'stopped' },
        });
      }
      return { stopped: cas.count > 0 };
    }
    return { stopped: true };
  }

  async messages(docId: string, tenantId: string) {
    await this.design.findOwned(docId, tenantId);
    return this.prisma.designMessage.findMany({
      where: { docId },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        role: true,
        type: true,
        content: true,
        seq: true,
        createdAt: true,
      },
    });
  }
}
