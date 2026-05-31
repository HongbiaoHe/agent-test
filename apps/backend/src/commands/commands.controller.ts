import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommandRegistryService } from './command-registry.service';

/** 供前端 `/` 自动补全拉取可用命令清单。 */
@Controller('commands')
@UseGuards(JwtAuthGuard)
export class CommandsController {
  constructor(private readonly registry: CommandRegistryService) {}

  @Get()
  list() {
    return this.registry.list();
  }
}
