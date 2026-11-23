import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MediaAnalysisProcessor } from './media-analysis.processor';
import { MediaAnalysisService } from './media-analysis.service';
import { VideoReviewController } from './video-review.controller';
import { VideoReviewService } from './video-review.service';

/**
 * 附件理解模块：media-analyze 队列 + 分析 worker + 服务。
 * 画布发送消息时投任务、worker 开跑前等结果并注入，agent 经 get_media_analysis 取细节。
 * 另有 desktop 剪辑工程的整片审片（POST /media-api/video-reviews），复用同一套 Gemini 调用。
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'media-analyze' })],
  controllers: [VideoReviewController],
  providers: [MediaAnalysisService, MediaAnalysisProcessor, VideoReviewService],
  exports: [MediaAnalysisService],
})
export class MediaAnalysisModule {}
