import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortModule } from '../agent/abort.module';
import { EventsModule } from '../events/events.module';
// stop 端点需要会话级取消媒体任务（cancelByConversation）
import { MediaModule } from '../media/media.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'agent-run' }),
    EventsModule,
    MediaModule,
    AbortModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
