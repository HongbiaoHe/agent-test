/**
 * McpModule — @Global()：McpService 由 worker 注入（装配 agent 工具），与 SkillsModule 同一做法，
 * worker 无需在自己的 imports 里再列。
 */
import { Global, Module } from '@nestjs/common';
import { McpController, McpOAuthController } from './mcp.controller';
import { McpService } from './mcp.service';

@Global()
@Module({
  controllers: [McpController, McpOAuthController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
