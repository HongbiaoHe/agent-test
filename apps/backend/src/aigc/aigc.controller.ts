import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AigcService } from './aigc.service';
import { type AigcCatalog, type AigcMediaType } from './aigc.types';

/**
 * 能力目录转发（需求：模型列表等 aigc 接口都经本服务转发，前端不直连 aigc、也拿不到 token）。
 * 只放开画布用到的 image / video 两类。
 */
@Controller('aigc')
@UseGuards(JwtAuthGuard)
export class AigcController {
  constructor(private readonly aigc: AigcService) {}

  /** GET /aigc/models?type=image|video → 该类型的可选模型 + 默认选择。 */
  @Get('models')
  models(@Query('type') type?: string): Promise<AigcCatalog> {
    const mediaType: AigcMediaType = type === 'video' ? 'video' : 'image';
    return this.aigc.catalog(mediaType);
  }
}
