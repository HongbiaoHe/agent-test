/**
 * Demo 用 mock 数据：一个 AI agent 对话界面的静态快照。
 * 场景：用户让 agent 分析前端首屏性能并产出优化报告。
 */

export type Conversation = {
  id: string;
  title: string;
  preview: string;
  updatedLabel: string;
};

export type ToolDetail = {
  kind: "tool";
  id: string;
  name: string;
  status: "success" | "running" | "error";
  durationLabel?: string;
  args: Record<string, unknown>;
  result: string;
};

export type FileDetail = {
  kind: "file";
  id: string;
  name: string;
  path: string;
  language: string;
  sizeLabel: string;
  lines: number;
  content: string;
};

export type Detail = ToolDetail | FileDetail;

export type Attachment = {
  detailId: string;
  type: "tool" | "file";
  label: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timeLabel: string;
  attachments?: Attachment[];
};

export const conversations: Conversation[] = [
  {
    id: "c1",
    title: "分析前端首屏性能",
    preview: "已生成优化报告，LCP 可从 3.2s 降到 1.4s …",
    updatedLabel: "刚刚",
  },
  {
    id: "c2",
    title: "重构认证模块为 JWT",
    preview: "已拆分 auth.service，补充了 12 个单元测试",
    updatedLabel: "2 小时前",
  },
  {
    id: "c3",
    title: "分析 Q2 销售数据 CSV",
    preview: "环比增长 18%，华东区贡献最大 …",
    updatedLabel: "昨天",
  },
  {
    id: "c4",
    title: "搭建产品落地页",
    preview: "Hero + 定价 + FAQ 三段式已完成",
    updatedLabel: "周二",
  },
  {
    id: "c5",
    title: "修复支付回调超时",
    preview: "定位到 webhook 未做幂等，已加锁",
    updatedLabel: "上周",
  },
  {
    id: "c6",
    title: "整理本周工程周报",
    preview: "汇总了 3 个仓库的 47 次提交",
    updatedLabel: "上周",
  },
];

export const details: Record<string, Detail> = {
  "t-read-config": {
    kind: "tool",
    id: "t-read-config",
    name: "read_file",
    status: "success",
    durationLabel: "0.3s",
    args: { path: "apps/frontend/next.config.ts" },
    result: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { formats: ["image/avif", "image/webp"] },
  // ⚠️ 未开启 productionBrowserSourceMaps 之外的拆包优化
};

export default nextConfig;`,
  },
  "t-build": {
    kind: "tool",
    id: "t-build",
    name: "run_command",
    status: "success",
    durationLabel: "42.8s",
    args: { command: "next build", cwd: "apps/frontend" },
    result: `Route (app)                        Size    First Load JS
┌ ○ /                              5.1 kB        142 kB
├ ○ /agent                        18.3 kB        221 kB   ← 偏大
└ ○ /demo/template                 9.7 kB        158 kB

○  (Static)  prerendered as static content
⚠ 首屏 JS 超过 170 kB 预算，主要来自未拆分的图表库`,
  },
  "t-search": {
    kind: "tool",
    id: "t-search",
    name: "web_search",
    status: "success",
    durationLabel: "1.1s",
    args: { query: "Next.js 16 reduce first load JS dynamic import" },
    result: `Top results:
1. nextjs.org/docs — Lazy Loading with next/dynamic
2. web.dev — Reduce JavaScript payloads with code splitting
3. Core Web Vitals: LCP 优化清单（2025）`,
  },
  "t-running": {
    kind: "tool",
    id: "t-running",
    name: "analyze_bundle",
    status: "running",
    args: { entry: "app/agent/page.tsx" },
    result: "正在解析依赖图并计算每个 chunk 的体积占比…",
  },
  "f-report": {
    kind: "file",
    id: "f-report",
    name: "perf-report.md",
    path: "docs/perf-report.md",
    language: "markdown",
    sizeLabel: "3.4 KB",
    lines: 48,
    content: `# 首屏性能优化报告

## 现状
- LCP：3.2s（移动端慢速 4G）
- 首屏 JS：221 kB（/agent 路由）
- 主要瓶颈：图表库在首屏同步加载

## 建议
1. 用 \`next/dynamic\` 懒加载图表组件，预计省下 ~60 kB
2. 给首屏图片声明 width/height，消除 CLS
3. 字体改用 \`display: swap\`，避免 FOIT

## 预期收益
| 指标 | 现在 | 优化后 |
| --- | --- | --- |
| LCP | 3.2s | ~1.4s |
| 首屏 JS | 221 kB | ~150 kB |`,
  },
  "f-chart": {
    kind: "file",
    id: "f-chart",
    name: "LazyChart.tsx",
    path: "apps/frontend/src/components/lazy-chart.tsx",
    language: "tsx",
    sizeLabel: "0.6 KB",
    lines: 14,
    content: `"use client";

import dynamic from "next/dynamic";

// 懒加载图表，移出首屏 bundle
export const LazyChart = dynamic(
  () => import("./heavy-chart").then((m) => m.HeavyChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted" />,
  },
);`,
  },
};

export const messages: Message[] = [
  {
    id: "m1",
    role: "user",
    content:
      "帮我分析一下 apps/frontend 的首屏性能，找出主要瓶颈，并给出可落地的优化方案。",
    timeLabel: "14:02",
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "好的，我先读取构建配置、跑一次生产构建看产物体积，再结合最佳实践给出方案。先看配置：",
    timeLabel: "14:02",
    attachments: [
      { detailId: "t-read-config", type: "tool", label: "read_file · next.config.ts" },
    ],
  },
  {
    id: "m3",
    role: "assistant",
    content:
      "配置里图片格式已经用了 AVIF/WebP，但没有针对首屏 JS 做拆包。我跑一次生产构建确认产物体积：",
    timeLabel: "14:03",
    attachments: [
      { detailId: "t-build", type: "tool", label: "run_command · next build" },
    ],
  },
  {
    id: "m4",
    role: "assistant",
    content:
      "确认了：`/agent` 路由首屏 JS 达 221 kB，超出预算，主要来自首屏同步加载的图表库。我查了一下当前推荐的拆分做法：",
    timeLabel: "14:03",
    attachments: [
      { detailId: "t-search", type: "tool", label: "web_search · code splitting" },
    ],
  },
  {
    id: "m5",
    role: "assistant",
    content:
      "我把详细分析整理成了报告，并写了一个懒加载图表的示例组件，你可以直接参考落地。正在进一步分析各 chunk 占比：",
    timeLabel: "14:04",
    attachments: [
      { detailId: "f-report", type: "file", label: "perf-report.md" },
      { detailId: "f-chart", type: "file", label: "LazyChart.tsx" },
      { detailId: "t-running", type: "tool", label: "analyze_bundle · 运行中" },
    ],
  },
];

/** 默认在右侧详情面板中展示的内容 */
export const defaultDetailId = "f-report";
