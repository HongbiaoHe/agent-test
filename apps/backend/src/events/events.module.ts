import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { StreamService } from './stream.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'agent-run' })],
  providers: [StreamService, EventsGateway],
  exports: [StreamService],
})
export class EventsModule {}
