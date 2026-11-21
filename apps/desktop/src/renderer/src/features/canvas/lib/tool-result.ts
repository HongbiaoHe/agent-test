/**
 * create_canvas / open_canvas 的工具结果（LangChain 把返回值序列化成 JSON 字符串）→ 对话里的画布卡片。
 * 形状 `{ canvasId, title, opened: true, nodes? }`；失败结果（{ error } / 报错文本）返回 null，不出卡片。
 */
import { z } from 'zod';

const resultSchema = z.object({
  canvasId: z.string().min(1),
  title: z.string().nullable().catch(null),
  nodes: z.number().int().nonnegative().optional(),
  opened: z.literal(true),
});

export type CanvasCardInfo = z.output<typeof resultSchema>;

/** 出画布卡片的工具（与 agent-host 注册的工具名同一份，见 shared/canvas.ts） */
export { CANVAS_CARD_TOOLS } from '../../../../../shared/canvas';

export function parseCanvasResult(content: unknown): CanvasCardInfo | null {
  let raw: unknown = content;
  if (typeof content === 'string') {
    try {
      raw = JSON.parse(content);
    } catch {
      return null;
    }
  }
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
