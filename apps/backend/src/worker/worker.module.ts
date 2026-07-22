import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortModule } from '../agent/abort.module';
import { checkpointerProvider } from '../agent/checkpointer.provider';
import { EventsModule } from '../events/events.module';
// 有意的模块依赖：worker 是 media 工具的注入点，耦合收敛在此，agent.factory 不感知 media 模块
import { MediaModule } from '../media/media.module';
import { AgentProcessor } from './agent.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'agent-run' }),
    EventsModule,
    MediaModule,
    AbortModule,
  ],
  providers: [AgentProcessor, checkpointerProvider],
})
export class WorkerModule {}
