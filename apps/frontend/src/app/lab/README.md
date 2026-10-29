# Lab · 页面效果实验场

一个**专门验收 agent 实现的页面效果**的模块。

产品主流程（`/agent`、`/canvas`、`/conversations`…）只放经过验证的界面；实验性质的、
一次性的、偏视觉 Demo 的页面全部放这里。每个实现都是独立路由的全屏页面，入口统一在
[`/lab`](./page.tsx) 索引页登记。

- 索引页：`src/app/lab/page.tsx`（遵循 manus 暖中性设计系统）
- 条目登记：`src/app/lab/_data/implementations.ts`
- 首页入口：悬浮导航 `Lab`、首页「AgentSpark Lab」区块、页脚 `Explore > Lab experiments`
- 当前实现：
  - [`/lab/rainy-store`](./rainy-store/page.tsx) —— 雨夜便利店街角微缩 3D 场景

## 约定

1. **独立路由**：一个实现一个目录，`app/lab/<slug>/page.tsx`；索引页只读 `_data/implementations.ts`。
2. **沉浸式页面不套宿主 UI**：像 3D 场景这类页面要求"没有任何 UI 界面元素"，就真的不能有
   header / 按钮 / 提示浮层；返回索引靠浏览器后退，或从 `/lab` 进入。
3. **不要求登录**：`/lab` 不在 `middleware.ts` 的保护前缀里，默认公开可访问。
4. **索引页用设计 token**：`bg-background` / `text-foreground` / `border-border` 等语义 token，
   亮暗两套都要成立；不要把实验页面里的自造色板带到索引页。
5. **重资源页面延迟加载**：Three.js / 大体积可视化只在客户端加载（`dynamic(..., { ssr: false })`），
   不要让索引页或首屏为它买单。
6. **性能兜底**：DPR 上限、`prefers-reduced-motion` 已由场景核心处理；新增重动效页面请自行遵守。

## 新增一个实现

1. 建目录与页面：

   ```tsx
   // src/app/lab/my-demo/page.tsx
   import type { Metadata } from "next";

   export const metadata: Metadata = { title: "我的实验 | AgentSpark Lab" };

   export default function MyDemoPage() {
     return <main className="fixed inset-0 ...">...</main>;
   }
   ```

2. 在 `_data/implementations.ts` 的 `LAB_ENTRIES` 里追加一条（`id` 递增，`preview` 用
   `public/lab/*.png` 的静态图）。
3. 跑通 `npx tsc --noEmit`、`pnpm lint`，截图确认亮 / 暗两个模式下索引页正常。

## 雨夜便利店街角（第一个实现）

- 技术栈：`three` + `@react-three/fiber` + `@react-three/drei` + `@react-three/postprocessing`。
- 结构：
  - `_scene/core/` —— 场景底座、三渲二材质、灯光、湿地反射、雨、相机、组装动画框架
  - `_scene/store/` —— 便利店建筑、橱窗、室内、招牌、雨棚
  - `_scene/street/` —— 马路、人行道、标线、积水、路灯、电线杆、小巷
  - `_scene/props/` —— 贩卖机、自行车、垃圾桶、猫等生活物件
  - `_scene/ART-SPEC.md` —— 施工图（坐标 / 尺寸 / 配色 / 动画时序）
- 交互：拖拽旋转、滚轮缩放；无平移，保证模型始终在画面里。
- 动画：从地面依次升起组装 → 灯逐个亮起 → 开始下雨；`prefers-reduced-motion` 下直接呈现终态。
- 性能：DPR 上限 1.5；前场倒影用 three `Reflector` 且每 3 帧才更新一次（湿地面是模糊倒影，
  看不出延迟），阴影只保留一盏 1024 的月光投影；桌面 1440×900 实测约 58fps（M4 / Chrome headless）。
