import { Film, Image as ImageIcon, Type, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { CanvasNodeType } from "@/lib/api";

import { NODE_TYPE_LABEL } from "../_lib/node-io";

/**
 * 节点类型的展示元数据（图标 / 缺省名 / 身份色）——画布上任何要「表明这是哪类节点」的地方
 * 都从这里取：节点卡片、编辑面板的类型标、关联输入列表。
 *
 * 身份色只用在**图标与连接点**上，卡面保持中性（设计系统 §7：靠深浅不靠彩色）。
 * 色值定义见 globals.css 的 --node-*（亮暗各一套）。
 */
export const NODE_META: Record<
  CanvasNodeType,
  { label: string; Icon: LucideIcon; tone: string }
> = {
  text: { label: NODE_TYPE_LABEL.text, Icon: Type, tone: "var(--node-text)" },
  image_upload: {
    label: NODE_TYPE_LABEL.image_upload,
    Icon: Upload,
    tone: "var(--node-upload)",
  },
  image_gen: {
    label: NODE_TYPE_LABEL.image_gen,
    Icon: ImageIcon,
    tone: "var(--node-image)",
  },
  video_gen: {
    label: NODE_TYPE_LABEL.video_gen,
    Icon: Film,
    tone: "var(--node-video)",
  },
};

/** 类型图标（身份色）。size 传 Tailwind 尺寸类，默认 12px。 */
export function NodeTypeIcon({
  type,
  className = "size-3",
}: {
  type: CanvasNodeType;
  className?: string;
}) {
  const { Icon, tone } = NODE_META[type];
  return (
    <Icon
      className={className + " shrink-0"}
      // 身份色经内联 style 而不是 className：色值是 CSS 变量，Tailwind 没有对应工具类
      style={{ color: tone }}
      aria-hidden
    />
  );
}
