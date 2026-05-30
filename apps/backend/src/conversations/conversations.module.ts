import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'agent-run' })],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
