import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MediaAnalysisService } from './media-analysis.service';

/**
 * 附件理解 worker（队列 media-analyze）：每个附件一个任务，并发分析。
 * 与生成（media-gen）、对账（media-poll）各走各的队列，互不抢槽位。
 */
@Processor('media-analyze', { concurrency: 4 })
export class MediaAnalysisProcessor extends WorkerHost {
  constructor(private readonly analysis: MediaAnalysisService) {
    super();
  }

  async process(job: Job<{ versionId: string }>): Promise<void> {
    await this.analysis.analyze(job.data.versionId);
  }
}
