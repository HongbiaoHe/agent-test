import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  SANDBOX_MIGRATE_QUEUE,
  type SandboxMigrateJob,
  SandboxMigrationService,
} from './sandbox-migration.service';

/**
 * 沙箱换档迁移的队列消费者。一单最长约十几分钟（打包 / 传输 / 解包），lockDuration 给足；
 * 不重试：中途失败已由 service 回滚并写进记录，重跑会再建一台新沙箱。
 */
@Processor(SANDBOX_MIGRATE_QUEUE, { concurrency: 2, lockDuration: 600_000 })
export class SandboxMigrationProcessor extends WorkerHost {
  constructor(private readonly migration: SandboxMigrationService) {
    super();
  }

  async process(job: Job<SandboxMigrateJob>): Promise<void> {
    await this.migration.run(job.data.migrationId, job.data.excludes);
  }
}
