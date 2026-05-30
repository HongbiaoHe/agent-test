import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { checkpointerProvider } from '../agent/checkpointer.provider';
import { EventsModule } from '../events/events.module';
import { AgentProcessor } from './agent.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'agent-run' }), EventsModule],
  providers: [AgentProcessor, checkpointerProvider],
})
export class WorkerModule {}
