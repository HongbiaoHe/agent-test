import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortRegistry } from '../agent/abort-registry';
import { AigcModule } from '../aigc/aigc.module';
import { EventsModule } from '../events/events.module';
import {
  DESIGN_ABORTS,
  DESIGN_RUN_QUEUE,
  DesignAgentService,
} from './agent/design-agent.service';
import { DesignRunProcessor } from './agent/design-run.processor';
import { DesignAssetsService } from './design-assets.service';
import { DesignDecomposeService } from './design-decompose.service';
import { DesignGenProcessor } from './design-gen.processor';
import { DESIGN_GEN_QUEUE } from './design-gen.util';
import { DesignGenerationService } from './design-generation.service';
import { DesignController } from './design.controller';
import { DesignGateway } from './design.gateway';
import { DesignService } from './design.service';
import { DesignRenderService } from './render/design-render.service';
import { SeedreamClient } from './seedream/seedream.client';

/**
 * 分图层设计模块（高内聚、独立于主 agent 与画布）：独立队列 design-run / design-gen、
 * 独立 processor / gateway / abort、独立模型白名单。只复用 aigc（生图与上传地址）与事件流；Seedream 5.0 Pro 直连 BytePlus。
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: DESIGN_RUN_QUEUE },
      { name: DESIGN_GEN_QUEUE },
    ),
    EventsModule,
    AigcModule,
  ],
  controllers: [DesignController],
  providers: [
    DesignService,
    DesignAssetsService,
    DesignGenerationService,
    DesignDecomposeService,
    SeedreamClient,
    DesignGenProcessor,
    DesignRenderService,
    DesignAgentService,
    DesignRunProcessor,
    DesignGateway,
    { provide: DESIGN_ABORTS, useFactory: () => new AbortRegistry() },
  ],
})
export class DesignModule {}
