import { Module } from '@nestjs/common';
import { AbortRegistry, AGENT_ABORTS, MEDIA_ABORTS } from './abort-registry';

/**
 * Abort 注册表装配：两个独立单例（agent-run / media-gen），
 * 被 WorkerModule、ConversationsModule、MediaModule 共享（Nest 模块实例缓存
 * 保证跨 importer 拿到同一 provider 实例）。
 */
@Module({
  providers: [
    { provide: AGENT_ABORTS, useValue: new AbortRegistry() },
    { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
  ],
  exports: [AGENT_ABORTS, MEDIA_ABORTS],
})
export class AbortModule {}
