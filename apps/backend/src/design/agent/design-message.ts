import {
  designModelSchema,
  httpUrlSchema,
  layerIdSchema,
} from '@agent-test/design-schema';
import { z } from 'zod';

/**
 * 用户发给设计 agent 的一条消息（POST /design/:id/messages 的 body，也原样落库重放）。
 * attachments 是已经经 /design/:id/uploads 转存到 CDN 的图片。
 */
export const designUserMessageSchema = z.strictObject({
  text: z.string().max(8000),
  attachments: z
    .array(
      z.strictObject({
        url: httpUrlSchema,
        filename: z.string().max(255),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .max(8),
  /** 用户发送时选中的图层（agent 的「这个」「它」就指它们） */
  selection: z.array(layerIdSchema).max(100),
  /** 「拆分图层」入口转交过来的请求（问题 11 的 Y：拆分由 agent 完成） */
  splitLayerId: layerIdSchema.optional(),
});

export type DesignUserMessage = z.infer<typeof designUserMessageSchema>;

export const sendDesignMessageSchema = z.strictObject({
  message: designUserMessageSchema,
  model: designModelSchema.optional(),
});
