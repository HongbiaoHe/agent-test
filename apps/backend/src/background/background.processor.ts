import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BG_QUEUE, BackgroundService } from './background.service';

/**
 * bg-task 队列：每个 job 是某个后台任务的一次推进（tick），推进完由 service 按需排下一次。
 * 延迟 job 存在 Redis 里，后端重启后照常继续。
 */
@Processor(BG_QUEUE, { concurrency: 5 })
export class BackgroundProcessor extends WorkerHost {
  private readonly logger = new Logger(BackgroundProcessor.name);

  constructor(private readonly background: BackgroundService) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    try {
      await this.background.tick(job.data.taskId);
    } catch (e) {
      // 推进链断了任务就会永远停在 running：意外错误直接判失败并照常通知 agent
      this.logger.error(`后台任务 ${job.data.taskId} 推进失败：${String(e)}`);
      await this.background.failUnexpected(job.data.taskId, e);
    }
  }
}
