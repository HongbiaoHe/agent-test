import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { checkpointerProvider } from '../agent/checkpointer.provider';
import { EventsModule } from '../events/events.module';
// 有意的模块依赖：canvas 是 media 工具的注入点，耦合收敛在此，canvas.agent.factory 不感知 media
import { MediaModule } from '../media/media.module';
import { canvasAbortsProvider } from './canvas.abort';
import { CanvasController } from './canvas.controller';
import { CanvasGateway } from './canvas.gateway';
import { CanvasProcessor } from './canvas.processor';
import { CanvasService } from './canvas.service';

/**
 * 画布工作流模块（高内聚，独立于现有 agent）：独立队列 canvas-run、独立 processor/gateway、
 * 独立 abort（canvasAbortsProvider）。复用 StreamService（EventsModule）与 MediaService（MediaModule）。
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'canvas-run' }),
    EventsModule,
    MediaModule,
  ],
  controllers: [CanvasController],
  providers: [
    CanvasService,
    CanvasProcessor,
    CanvasGateway,
    checkpointerProvider,
    canvasAbortsProvider,
  ],
})
export class CanvasModule {}
