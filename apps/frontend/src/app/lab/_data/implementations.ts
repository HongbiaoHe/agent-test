/**
 * Lab 条目登记表。
 * 新增一个「agent 实现的页面效果」时：在 app/lab/ 下建独立路由，然后在这里加一条。
 * 这里的元数据只服务索引页展示，页面本身不依赖它。
 */
export type LabEntry = {
  /** 稳定 id，同时作为索引页角标 */
  id: string;
  title: string;
  description: string;
  href: string;
  /** 分类标签，如「3D 场景」「交互动效」 */
  category: string;
  tags: string[];
  /** 预览图（public 下路径），可选 */
  preview?: string;
};

export const LAB_ENTRIES: LabEntry[] = [
  {
    id: "001",
    title: "雨夜便利店街角",
    description:
      "12×12 正方形底座上的日式便利店街角微缩模型。三渲二夜景、雨丝与霓虹倒影，可自由拖拽旋转缩放；开场由散件从地面逐层组装，灯光依次接通。",
    href: "/lab/rainy-store",
    category: "3D 场景",
    tags: ["Three.js", "三渲二", "微缩模型", "入场动画"],
    preview: "/lab/rainy-store.jpg",
  },
  {
    id: "002",
    title: "低多边形悬浮岛",
    description:
      "程序化建模的低多边形悬浮岛：岛体、树、飞鸟、山羊与奶牛全部由 bpy 在对话里生成后导出 glTF。四套配色可实时切换，动物带对角步态行走、低头吃草与甩尾；拖拽旋转、滚轮缩放查看。",
    href: "/lab/island",
    category: "3D 场景",
    tags: ["Three.js", "React Three Fiber", "glTF", "程序化建模"],
    preview: "/lab/island.jpg",
  },
];
