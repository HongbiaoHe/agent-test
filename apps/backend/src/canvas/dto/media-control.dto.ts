import { IsOptional, IsString } from 'class-validator';

/** 暂停 / 继续画布上的生成：不传 nodeId = 整张画布；传了 = 该节点及其全部下游。 */
export class MediaControlDto {
  @IsOptional()
  @IsString()
  nodeId?: string;
}
