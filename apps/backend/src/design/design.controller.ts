import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  canvasSchema,
  designModelSchema,
  designOpBatchSchema,
  imageModelChoiceSchema,
  layerIdSchema,
} from '@agent-test/design-schema';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { DesignAgentService } from './agent/design-agent.service';
import { sendDesignMessageSchema } from './agent/design-message';
import { DesignAssetsService } from './design-assets.service';
import { DesignDecomposeService } from './design-decompose.service';
import { DesignGenerationService } from './design-generation.service';
import { DesignService } from './design.service';
import { DesignRenderService } from './render/design-render.service';

const createSchema = z.strictObject({
  title: z.string().max(120).optional(),
  canvas: canvasSchema.optional(),
});
const metaSchema = z.strictObject({
  title: z.string().max(120).optional(),
  model: designModelSchema.optional(),
  imageModel: imageModelChoiceSchema.optional(),
});
const opsSchema = z.strictObject({
  ops: designOpBatchSchema,
  clientId: z.string().min(1).max(64),
});
const generateSchema = z.strictObject({
  prompt: z.string().min(1).max(4000),
  referenceUrls: z
    .array(z.url({ protocol: /^https?$/ }))
    .max(8)
    .optional(),
  useCurrentAsReference: z.boolean().optional(),
});
const decomposeSchema = z.strictObject({
  prompt: z.string().max(2000).optional(),
});

/** body 统一用共享 zod schema 收窄（全局 ValidationPipe 只认 class-validator DTO，这里不走它）。 */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new BusinessException(
      { code: ErrorCodes.DESIGN_OP_INVALID.code, message: msg },
      HttpStatus.BAD_REQUEST,
    );
  }
  return r.data;
}

/** 列表缩略图缓存：docId → (revision, png)。缩略图只随 revision 变。 */
const THUMB_CACHE_MAX = 200;

@Controller('design')
@UseGuards(JwtAuthGuard)
export class DesignController {
  private readonly thumbs = new Map<
    string,
    { revision: number; png: Buffer }
  >();

  constructor(
    private readonly design: DesignService,
    private readonly agent: DesignAgentService,
    private readonly generation: DesignGenerationService,
    private readonly assets: DesignAssetsService,
    private readonly render: DesignRenderService,
    private readonly decomposer: DesignDecomposeService,
  ) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.design.create(
      user.tenantId,
      user.userId,
      parse(createSchema, body),
    );
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.design.list(user.tenantId, user.userId);
  }

  /** 生图模型下拉：目录里支持透明背景的模型（动态推导）。 */
  @Get('image-models')
  imageModels() {
    return this.generation.imageModels();
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.design.get(id, user.tenantId);
  }

  @Patch(':id')
  updateMeta(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    return this.design.updateMeta(id, user.tenantId, parse(metaSchema, body));
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.design.remove(id, user.tenantId);
    this.thumbs.delete(id);
    return { ok: true };
  }

  @Post(':id/ops')
  applyOps(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    const { ops, clientId } = parse(opsSchema, body);
    return this.design.applyUserOps(id, user.tenantId, ops, clientId);
  }

  /** 图层生成 / 重新生成（人在属性面板点的；「文字生成图层」是先 add_layers 再调它）。 */
  @Post(':id/layers/:layerId/generate')
  async generate(
    @Param('id') id: string,
    @Param('layerId') layerId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    await this.design.findOwned(id, user.tenantId);
    return this.generation.start(
      id,
      parse(layerIdSchema, layerId),
      parse(generateSchema, body),
      'user',
    );
  }

  /** 拆层（Seedream 5.0 Pro）：用户点失败图层的「重试」时直接调；agent 走 decompose_layer 工具。 */
  @Post(':id/layers/:layerId/decompose')
  async decompose(
    @Param('id') id: string,
    @Param('layerId') layerId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    await this.design.findOwned(id, user.tenantId);
    return this.decomposer.start(
      id,
      parse(layerIdSchema, layerId),
      parse(decomposeSchema, body ?? {}).prompt,
      'user',
    );
  }

  /** 上传图片（请求体即文件二进制，经前端 /api/design/:id/uploads 流式转来）。 */
  @Post(':id/uploads')
  async upload(
    @Param('id') id: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Query('filename') filename: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    await this.design.findOwned(id, user.tenantId);
    const stored = await this.assets.storeUpload({
      body: req,
      contentType: (contentType ?? '').split(';')[0].trim(),
      size: Number(contentLength),
      filename:
        (filename ?? 'image').split(/[\\/]/).pop()?.slice(0, 255) || 'image',
    });
    return { ...stored, filename: filename ?? 'image' };
  }

  @Get(':id/messages')
  messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.agent.messages(id, user.tenantId);
  }

  @Post(':id/messages')
  send(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    const { message, model } = parse(sendDesignMessageSchema, body);
    return this.agent.send(id, user.tenantId, message, model);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.agent.stop(id, user.tenantId);
  }

  /** 列表缩略图（后端同构渲染，按 revision 缓存）。直接回 PNG，不走 JSON 信封。 */
  @Get(':id/thumbnail.png')
  async thumbnail(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const snap = await this.design.get(id, user.tenantId);
    let hit = this.thumbs.get(id);
    if (hit?.revision !== snap.revision) {
      hit = {
        revision: snap.revision,
        png: await this.render.render(snap.document, { maxSide: 480 }),
      };
      if (this.thumbs.size >= THUMB_CACHE_MAX) {
        // Map 按插入顺序迭代：第一个键即最早缓存的那张
        for (const oldest of this.thumbs.keys()) {
          this.thumbs.delete(oldest);
          break;
        }
      }
      this.thumbs.set(id, hit);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.end(hit.png);
  }
}
