import { IsNumber } from 'class-validator';

/** 节点位置更新（LWW，不占 revision、不进 op 日志、不 409）。 */
export class MoveNodeDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;
}
