import { Module } from '@nestjs/common';
import { CanvasModule } from '../canvas/canvas.module';
import { MediaModule } from '../media/media.module';
import { McpCanvasService } from './mcp-canvas.service';
import { McpGrantService } from './mcp-grant.service';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { McpServerController } from './mcp-server.controller';
import { McpServerHttp } from './mcp-server.http';

/**
 * 画布 MCP 对外服务：第三方 agent 经 /mcp 操作画布（设计见
 * docs/superpowers/specs/2026-11-21-canvas-mcp-server-design.md）。
 * 对外公开面：McpServerHttp（main.ts 挂到 express）+ McpServerController（站内接口）。
 */
@Module({
  imports: [CanvasModule, MediaModule],
  controllers: [McpServerController],
  providers: [
    McpGrantService,
    McpOAuthProvider,
    McpCanvasService,
    McpServerHttp,
  ],
  exports: [McpServerHttp],
})
export class McpServerModule {}
