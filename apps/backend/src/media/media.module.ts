import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortModule } from '../agent/abort.module';
import { EventsModule } from '../events/events.module';
import { MediaController } from './media.controller';
import { MediaProcessor } from './media.processor';
import { MediaService } from './media.service';
import { GoogleMediaClient } from './google-media.client';

/**
 * 媒体模块：注册 media-gen 队列，装配 service/processor/controller/client。
 * imports EventsModule —— service/processor 经 StreamService 推 media_update（EventsModule 导出它）。
 * imports AbortModule —— 停止功能的协作取消注册表（service 取消 / processor 注册）。
 * exports MediaService —— worker 模块（M3）将 imports 本模块并注入 MediaService 构造媒体工具。
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'media-gen' }), EventsModule, AbortModule],
  controllers: [MediaController],
  providers: [MediaService, MediaProcessor, GoogleMediaClient],
  exports: [MediaService],
})
export class MediaModule {}
