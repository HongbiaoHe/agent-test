import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DesignDecomposeService } from './design-decompose.service';
import { DESIGN_GEN_QUEUE, type DesignGenJob } from './design-gen.util';
import { DesignGenerationService } from './design-generation.service';

/**
 * 生成队列的消费者：单图层生成（aigc 提交 + 轮询，或 Seedream 同步请求）与拆层。
 * 一单最长约 10 分钟（Seedream 同步请求的超时）。
 */
// lockDuration 取短：进程活着时 BullMQ 每半个周期自动续锁；进程被杀（重启 / 部署）后
// 约 1 分钟就判定 stalled 重跑，配合图层上记的 taskId 接着轮询原任务（不重复提交）
@Processor(DESIGN_GEN_QUEUE, { concurrency: 12, lockDuration: 60_000 })
export class DesignGenProcessor extends WorkerHost {
  private readonly logger = new Logger(DesignGenProcessor.name);

  constructor(
    private readonly generation: DesignGenerationService,
    private readonly decompose: DesignDecomposeService,
  ) {
    super();
  }

  async process(job: Job<DesignGenJob>): Promise<void> {
    try {
      if (job.data.kind === 'decompose') await this.decompose.run(job.data);
      else await this.generation.run(job.data);
    } catch (e) {
      // 不重试：落成图层的 error 状态，由用户点「重试」（落库本身再失败就只能记日志）
      this.logger.error(
        `design 生成任务异常 layer=${job.data.layerId}：${String(e)}`,
      );
      await this.generation
        .fail(job.data, e instanceof Error ? e.message : String(e))
        .catch(() => {});
    }
  }
}
