import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortModule } from '../agent/abort.module';
import { AigcModule } from '../aigc/aigc.module';
import { EventsModule } from '../events/events.module';
import { MediaCallbackController } from './media-callback.controller';
import { MediaController } from './media.controller';
import { MediaProcessor } from './media.processor';
import { MediaService } from './media.service';

/**
 * 媒体模块：注册 media-gen 队列，装配 service/processor/controller。
 * imports EventsModule —— service/processor 经 StreamService 推 media_update（EventsModule 导出它）。
 * imports AbortModule —— 停止功能的协作取消注册表（service 取消 / processor 注册）。
 * imports AigcModule —— 图片/视频生成统一走 aigc 服务（接单 + 回调），本模块只管状态流转与资产。
 * exports MediaService —— worker 模块将 imports 本模块并注入 MediaService 构造媒体工具。
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'media-gen' }),
    EventsModule,
    AbortModule,
    AigcModule,
  ],
  controllers: [MediaController, MediaCallbackController],
  providers: [MediaService, MediaProcessor],
  exports: [MediaService],
})
export class MediaModule {}
