import { IsBoolean } from 'class-validator';

/** 更新技能启停状态（前端管理页用）。 */
export class UpdateSkillDto {
  @IsBoolean()
  enabled!: boolean;
}
