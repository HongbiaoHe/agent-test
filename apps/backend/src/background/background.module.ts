/**
 * BackgroundModule — @Global()：BackgroundService 由 worker（装配工具 / 本轮结束后投递通知）
 * 与 conversations（停止时一并取消）注入。
 */
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BackgroundController } from './background.controller';
import { BackgroundProcessor } from './background.processor';
import { BG_QUEUE, BackgroundService } from './background.service';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: BG_QUEUE }, { name: 'agent-run' }),
    EventsModule,
    SandboxModule,
  ],
  controllers: [BackgroundController],
  providers: [BackgroundService, BackgroundProcessor],
  exports: [BackgroundService],
})
export class BackgroundModule {}
