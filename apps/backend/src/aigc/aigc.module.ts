import { Module } from '@nestjs/common';
import { AigcClient } from './aigc.client';
import { AigcController } from './aigc.controller';
import { AigcService } from './aigc.service';
import { PublicUrlService } from './public-url.service';

/**
 * aigc 生成服务接入模块：能力目录 + 接单 + 我方公网基址解析。
 * exports AigcService / PublicUrlService —— 媒体域（MediaModule）消费它们提交生成任务；
 * exports AigcClient —— 媒体域的文件上传直接调它申请上传地址（不涉及目录与接单）。
 */
@Module({
  controllers: [AigcController],
  providers: [AigcClient, AigcService, PublicUrlService],
  exports: [AigcService, PublicUrlService, AigcClient],
})
export class AigcModule {}
