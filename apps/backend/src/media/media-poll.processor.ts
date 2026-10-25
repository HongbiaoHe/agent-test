import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MediaService } from './media.service';

/**
 * 对账轮询 worker（队列 media-poll）：回调收不到时（本地没开隧道、回调丢了）按轮去 aigc 查结果，
 * 见 MediaService.reconcile / scheduleReconcile。
 *
 * 必须与生成队列 media-gen 分开：一步触发整条工作流时，下游会占着 media-gen 的槽位等上游出结果；
 * 上游的对账若也排在 media-gen，就永远轮不到——上游标不成 done，下游等到超时失败
 * （2026-10-25 实测：3 个视频占满 3 个槽位，3 张已生成好的图在 aigc 那头卡了 5 分钟）。
 * 对账只是查一次接口、改一行库，并发给足即可。
 */
@Processor('media-poll', { concurrency: 5 })
export class MediaPollProcessor extends WorkerHost {
  constructor(private readonly media: MediaService) {
    super();
  }

  async process(
    job: Job<{ versionId: string; attempt?: number }>,
  ): Promise<void> {
    await this.media.reconcile(job.data.versionId, job.data.attempt ?? 1);
  }
}
