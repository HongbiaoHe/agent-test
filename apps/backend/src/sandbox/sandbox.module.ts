import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SandboxMigrationProcessor } from './sandbox-migration.processor';
import {
  SANDBOX_MIGRATE_QUEUE,
  SandboxMigrationService,
} from './sandbox-migration.service';
import { SandboxController } from './sandbox.controller';
import { SandboxSettingsService } from './sandbox-settings.service';
import { SandboxStatusService } from './sandbox.service';

/**
 * 沙箱模块：user 级状态查询（不创建不唤醒）+ 提供方偏好 + 配置档位换档迁移。
 * 导出 SandboxSettingsService：worker / conversations 据此取该用户生效的提供方；
 * 导出 SandboxMigrationService：conversations 在迁移期间拒绝新的运行。
 */
@Module({
  imports: [BullModule.registerQueue({ name: SANDBOX_MIGRATE_QUEUE })],
  controllers: [SandboxController],
  providers: [
    SandboxStatusService,
    SandboxSettingsService,
    SandboxMigrationService,
    SandboxMigrationProcessor,
  ],
  exports: [SandboxSettingsService, SandboxMigrationService],
})
export class SandboxModule {}
