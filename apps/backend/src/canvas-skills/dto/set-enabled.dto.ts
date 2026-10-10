import { IsBoolean } from 'class-validator';

/** 启用 / 停用一个用户技能（内置技能不接受此操作）。 */
export class SetCanvasSkillEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
