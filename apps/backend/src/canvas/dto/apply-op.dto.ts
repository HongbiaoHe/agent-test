import { IsInt, IsObject, Min } from 'class-validator';

/**
 * 用户结构编辑请求（空闲期）。op 的具体形状由 service 用 zod 收窄校验（见 canvas.op-schema）；
 * 这里只校验信封：baseRevision（乐观并发游标）+ op 是对象。
 */
export class ApplyOpDto {
  @IsInt()
  @Min(0)
  baseRevision!: number;

  @IsObject()
  op!: Record<string, unknown>;
}
