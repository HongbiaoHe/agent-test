# DESIGN.md — 设计系统语言

> 本文档是从代码反向提炼的**现状快照**，唯一事实来源（single source of truth）是
> [`src/app/globals.css`](src/app/globals.css)。两者冲突时以 `globals.css` 为准，并回来更新本文。
> 配套行为约束见仓库根 `CLAUDE.md` §6（组件复用 / shadcn）、§7（设计 token）。

---

## 1. 设计理念

**manus 风格的暖中性（warm-neutral）系统**（`globals.css:7-11`）：

- 暖白底 / 暖近黑字 / 极细低对比边框 / 深色主按钮。
- **靠深浅对比而非彩色**表达层级，保持简洁高级。彩色仅用于功能语义（危险红、运行绿、告警黄）。
- 全部颜色用 `oklch` 表达，亮色（`:root`）与暗色（`.dark`）**两套独立取值**，不是简单反色。

---

## 2. 颜色 Token

定义于 `:root`（亮，`globals.css:12-57`）与 `.dark`（暗，`globals.css:59-100`）。**组件内只许用语义 token，禁止硬编码颜色**（无 `zinc-*/gray-*/slate-*`、无裸 hex）。

### 2.1 基础语义色（shadcn 标准集）

| Token | 亮色 oklch | 暗色 oklch | 用途 |
|-------|-----------|-----------|------|
| `--background` / `--foreground` | `0.988 0.002 75` / `0.18 0.005 60` | `0.17 0.004 60` / `0.95 0.002 80` | 页面底色 / 正文字 |
| `--card` / `--card-foreground` | `1 0 0` / `0.18 0.005 60` | `0.205 0.004 60` / `0.95 0.002 80` | 卡片面 / 卡片字 |
| `--popover` / `--popover-foreground` | `1 0 0` / `0.18 0.005 60` | `0.205 0.004 60` / `0.95 0.002 80` | 浮层 / 浮层字 |
| `--primary` / `--primary-foreground` | `0.22 0.006 60` / `0.985 0.002 80` | `0.92 0.002 80` / `0.205 0.005 60` | 主按钮（亮=深底浅字，暗=浅底深字） |
| `--secondary` / `--secondary-foreground` | `0.962 0.004 75` / `0.25 0.006 60` | `0.26 0.004 60` / `0.95 0.002 80` | 次级面 / 字 |
| `--muted` / `--muted-foreground` | `0.965 0.004 75` / `0.5 0.006 60` | `0.255 0.004 60` / `0.7 0.005 70` | 弱化背景 / 辅助字 |
| `--accent` / `--accent-foreground` | `0.958 0.004 75` / `0.22 0.006 60` | `0.28 0.004 60` / `0.95 0.002 80` | hover/选中底 / 字 |
| `--destructive` / `--destructive-foreground` | `0.58 0.19 25` / `0.985 0.002 80` | `0.62 0.19 25` / `0.985 0.002 80` | 危险/删除 |
| `--border` / `--input` | `0.916 0.004 75` | `1 0 0 / 8%` / `1 0 0 / 12%` | 边框 / 输入框边框（暗色用半透明白） |
| `--ring` | `0.68 0.01 60` | `0.55 0.01 70` | 焦点环 |

### 2.2 业务扩展色（非 shadcn 默认，项目自加）

| Token | 亮色 | 暗色 | 用途 | 出处 |
|-------|------|------|------|------|
| `--success` | `0.63 0.17 150` | `0.72 0.17 150` | 运行/在线指示（如沙箱心跳点） | `globals.css:44,88` |
| `--warning` | `0.72 0.15 75` | `0.78 0.14 80` | 告警指示 | `globals.css:45,89` |
| `--glow-color` | `0.64 0.015 60` | `0.92 0.002 80` | 旋转高光边框柔光色 | `globals.css:48,92` |
| `--syntax-comment/keyword/string/number/function/property` | 见源码 | 见源码 | highlight.js 代码语法配色 | `globals.css:51-56,94-99` |

> ⚠️ `--success` / `--warning` 已在 `@theme inline` 暴露为 `bg-success` / `text-warning` 等（`globals.css:122-123`）；
> `--glow-color` / `--syntax-*` 未走 `@theme`，通过专用 CSS 类消费（见 §8）。

---

## 3. Tailwind v4 映射与消费方式

token 经 `@theme inline`（`globals.css:102-133`）映射成工具类，直接用语义类名：

```tsx
// ✅ 正确
<div className="bg-background text-foreground">
  <div className="bg-card border-border text-card-foreground rounded-lg">…</div>
  <button className="bg-primary text-primary-foreground">主操作</button>
  <span className="text-muted-foreground">辅助说明</span>
</div>

// ❌ 禁止
<div className="bg-zinc-50 text-gray-900 border-[#e5e5e5]">…</div>
```

可用类：`bg-/text-/border-/ring-` × `background foreground card[-foreground] popover[-foreground]
primary[-foreground] secondary[-foreground] muted[-foreground] accent[-foreground]
destructive[-foreground] border input ring success warning`。

---

## 4. 圆角（Radius）

基准 `--radius: 0.625rem`（10px，`globals.css:13`），派生（`globals.css:125-129`）：

| 类 | 值 |
|----|----|
| `rounded-sm` | `--radius - 4px` |
| `rounded-md` | `--radius - 2px` |
| `rounded-lg` | `--radius`（基准） |
| `rounded-xl` | `--radius + 4px` |
| `rounded-4xl` | `2rem` |

按钮默认 `rounded-lg`，小尺寸降到 `min(--radius-md, 10~12px)`（`button.tsx:7,25-26`）。

## 5. 间距

无自定义 spacing token——**沿用 Tailwind 默认刻度**，遵循 CLAUDE.md §7 的 **4 / 8px 节奏**。

## 6. 字体

`next/font/google` 加载（`src/app/layout.tsx`），映射到 `@theme`（`globals.css:131-132`）：

| 角色 | 字体 | 变量 | Tailwind 类 |
|------|------|------|-------------|
| 正文 / 标题 | **Geist** | `--font-geist-sans` | `font-sans`（body 默认，`globals.css:140`） |
| 等宽 / 代码 | **Geist Mono** | `--font-geist-mono` | `font-mono` |

`<html>` 全局 `antialiased`（`layout.tsx`）。

---

## 7. 暗色模式机制（⚠️ 当前两套并存）

亮暗切换靠在 `<html>` 上挂 / 摘 `.dark` 类，配合 `@custom-variant dark (&:is(.dark *))`（`globals.css:5`）。
**但项目里有两套挂类的实现，需注意区分：**

1. **全局（推荐）** — `next-themes`，`src/app/providers.tsx`：
   `attribute="class"` + `defaultTheme="system"` + `enableSystem` + `disableTransitionOnChange`。
   跟随系统、持久化到 localStorage、预水合防闪烁。**新页面应复用这套。**

2. **局部轻量** — `demo/template/_hooks/use-theme.ts` 与 `agent/_hooks/use-theme.ts`：
   `useState("light")` + `useEffect` 手动 `classList.toggle("dark")`，固定浅色起步、仅当前会话生效、不持久化、不跟随系统。

> 取舍：两套都直接操作 `<html>.dark`，互不感知。同页面**不要混用**，否则状态会打架。
> 新功能优先用 `next-themes`；现有 demo/agent 的局部 hook 是历史实现，改动它们时保持原样即可。

任何新 token 都必须**同时**在 `:root` 和 `.dark` 给值，并各自验证对比度（不允许只调一套）。

---

## 8. 交互反馈与动效

### 8.1 全局点击反馈（`globals.css:143-153`）
所有 `a[href] / button / [role=button] / summary / label[for]`（排除 disabled）按下瞬间
`opacity: 0.65`，`transition: opacity 0.12s`。用 `:where()` 零特异性，不覆盖组件自身样式。

### 8.2 动效时长
微交互 ~120ms（全局反馈）；组件过渡用 `transition-all`。遵循 `prefers-reduced-motion`（GlowBorder 已做，`globals.css:222-226`）。

### 8.3 专用效果类
| 类 / 组件 | 作用 | 出处 |
|-----------|------|------|
| `.glow-border` / `<GlowBorder>` | conic-gradient 旋转高光边框，可调 `--glow-color/--glow-speed/--glow-width` | `globals.css:166-226` + `components/ui/glow-border.tsx` |
| `.animate-media-shimmer` | 媒体卡生成中高光横扫骨架 | `globals.css:155-164` |
| `.hljs-*` | highlight.js 语法高亮，映射到 `--syntax-*`，亮暗自适应 | `globals.css:228-271` |

> keyframe 必须写在 `globals.css` 全局——React 会跳过组件内 `<style>`/`<script>`，组件里写动画不生效。

---

## 9. 组件库

shadcn/ui（`components.json`）：

- `style: "base-nova"`，`baseColor: "neutral"`，`cssVariables: true`，RSC 开启。
- **图标库 `lucide`**（lucide-react）——禁止 emoji 当结构图标（CLAUDE.md §7）。
- 基础组件构建于 **`@base-ui/react`**（注意：不是 radix）。如 `Button` 基于 `@base-ui/react/button`。
- 别名：`@/components` `@/components/ui` `@/lib` `@/lib/utils` `@/hooks`。

### 9.1 已落地组件（`src/components/ui/`）
`avatar` `badge` `button` `card` `glow-border` `input` `scroll-area` `separator`
`sheet` `skeleton` `sonner`(toast) `switch` `tabs` `textarea` `tooltip`。

### 9.2 Button 变体规范（`components/ui/button.tsx`）
| variant | 表现 |
|---------|------|
| `default` | `bg-primary text-primary-foreground` + hover 降透明（主 CTA） |
| `outline` | `border-border bg-background`，hover→`bg-muted` |
| `secondary` | `bg-secondary`，hover 用 `color-mix` 微加深 |
| `ghost` | 透明，hover→`bg-muted` |
| `destructive` | `bg-destructive/10 text-destructive`（弱底强字） |
| `link` | 纯文字 + hover 下划线 |

size：`xs h-6` / `sm h-7` / `default h-8` / `lg h-9` / `icon[/-xs/-sm/-lg]`。
统一焦点环 `focus-visible:ring-3 ring-ring/50`、按下位移 `active:translate-y-px`、禁用态 `opacity-50`。

### 9.3 复用规约（CLAUDE.md §6）
默认用 shadcn 组件；不合适时**包裹/组合** shadcn 原语扩展，不从零手写。新业务组件**就近放在 feature 目录**（CLAUDE.md §5）。

### 9.4 Toast
`sonner`，`<Toaster position="top-center" />`（`providers.tsx`）；query/mutation 失败已全局自动 toast。

---

## 10. 参考实现

`src/app/demo/template/`（page/layout/`_components`/`_hooks`/`_data` 齐全）是设计系统的活样板。
**不确定某东西该长什么样时，打开它对照**（CLAUDE.md §7）。

---

## 11. 交付前自查（设计 token 维度）

- [ ] 只用语义 token，无 `zinc/gray/slate/*` 与裸 hex。
- [ ] 亮色 + 暗色都验证过（不是只看一套推断另一套）。
- [ ] 新增 token 在 `:root` 与 `.dark` **都**给了值。
- [ ] 圆角用 `rounded-sm/md/lg/xl`，间距守 4/8px。
- [ ] 图标全部 lucide，无 emoji。
- [ ] 优先复用/组合 shadcn 组件，未从零手写。
- [ ] 焦点环、按下反馈、禁用态在亮暗下都可辨。
