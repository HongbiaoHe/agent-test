import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

/**
 * 「加入对话」的节点圈选。空数组 = 取消圈定、恢复关注整块画布。
 * 上限与画布规模同量级即可——圈太多本身就失去了"只关注这几个"的意义。
 */
export class SetFocusDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  nodeIds!: string[];
}
