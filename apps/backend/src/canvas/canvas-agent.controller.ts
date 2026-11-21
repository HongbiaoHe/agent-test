import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { desktopScope } from '../media/media-api.controller';
import { MediaService } from '../media/media.service';
import { canvasAgentOpSchema } from './canvas.op-schema';
import { CanvasService } from './canvas.service';
import { createCanvasToolBackend } from './canvas.tools';
import {
  CanvasAgentConcatDto,
  CanvasAgentGenerationDto,
  CanvasAgentLockDto,
  CanvasAgentNodeConfigDto,
  CanvasAgentOpDto,
  CanvasAgentUnlockDto,
  CanvasAgentUploadedAssetDto,
} from './dto/canvas-agent.dto';

/**
 * desktop 本机 agent 操作画布的接口：画布工具定义在 agent-core（两端共用），desktop 的执行端经这里调到
 * **同一个** CanvasService / MediaService（服务端画布 agent 用的也是同一份执行端，见 createCanvasToolBackend）。
 *
 * 规矩与服务端 agent 运行时一致：desktop 改画布前先申请运行锁并定时续期（心跳），持锁期间其它端的用户
 * 只能拖位置、服务端画布 agent 不能开跑；每次写入（op / 生成 / 拼接）都校验锁还在自己手里。
 * 读操作（快照、模型目录）直接用 GET /canvas/:id 与 GET /media-api/models。
 */
@Controller('canvas-agent')
@UseGuards(JwtAuthGuard)
export class CanvasAgentController {
  constructor(
    private readonly canvas: CanvasService,
    private readonly media: MediaService,
  ) {}

  private backend(id: string, user: AuthUser, scope?: string) {
    return createCanvasToolBackend(this.canvas, this.media, {
      sessionId: id,
      userId: user.userId,
      uploadScope: scope ? desktopScope(scope) : undefined,
    });
  }

  /** 申请 / 续期运行锁（同一个 holderId 再调一次即续期） */
  @Post(':id/lock')
  lock(
    @Param('id') id: string,
    @Body() dto: CanvasAgentLockDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.acquireRunLock(
      id,
      user.tenantId,
      dto.holderId,
      dto.label ?? null,
    );
  }

  /** 释放运行锁（本轮结束） */
  @Post(':id/unlock')
  unlock(
    @Param('id') id: string,
    @Body() dto: CanvasAgentUnlockDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.releaseRunLock(id, user.tenantId, dto.holderId);
  }

  /** 注入给 agent 的画布文本（与服务端 agent 同一种写法） */
  @Get(':id/context')
  async context(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.canvas.assertAccess(id, user.tenantId);
    return { text: await this.canvas.agentCanvasContext(id) };
  }

  /** 以 agent 身份提交一次结构变更 */
  @Post(':id/ops')
  async applyOp(
    @Param('id') id: string,
    @Body() dto: CanvasAgentOpDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.canvas.assertRunLockHolder(id, user.tenantId, dto.holderId);
    return this.backend(id, user).applyOp(canvasAgentOpSchema.parse(dto.op));
  }

  /** 给生成节点设模型前的严格校验 */
  @Post(':id/node-config')
  async nodeConfig(
    @Param('id') id: string,
    @Body() dto: CanvasAgentNodeConfigDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.canvas.assertAccess(id, user.tenantId);
    return this.backend(id, user).prepareNodeConfig(dto.type, {
      model: dto.model,
      channel: dto.channel,
      params: dto.params,
      referenceCounts: dto.referenceCounts,
    });
  }

  /** 发起一次生成（记在这块画布名下）；业务拒绝回 { error } */
  @Post(':id/generations')
  async generate(
    @Param('id') id: string,
    @Body() dto: CanvasAgentGenerationDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.canvas.assertRunLockHolder(id, user.tenantId, dto.holderId);
    return this.backend(id, user).createGeneration({
      type: dto.type,
      prompt: dto.prompt,
      referenceVersionIds: dto.referenceVersionIds,
      config: dto.config,
    });
  }

  /** 发起一次视频拼接；业务拒绝回 { error } */
  @Post(':id/concats')
  async concat(
    @Param('id') id: string,
    @Body() dto: CanvasAgentConcatDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.canvas.assertRunLockHolder(id, user.tenantId, dto.holderId);
    return this.backend(id, user).createConcat(dto.sources);
  }

  /** desktop 对话里的附件（上传版本）：放上画布的上传节点前核对归属与类型；查不到回 { asset: null } */
  @Post(':id/uploaded-asset')
  async uploadedAsset(
    @Param('id') id: string,
    @Body() dto: CanvasAgentUploadedAssetDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.canvas.assertAccess(id, user.tenantId);
    return {
      asset: await this.backend(id, user, dto.scope).findUploadedAsset(
        dto.versionId,
      ),
    };
  }
}
