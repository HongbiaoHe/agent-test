# Skills kind 分类全链路改造 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **项目约束（CLAUDE.md，优先级最高）：** 禁止任何 git commit/push——所有提交由用户触发；本计划不含 commit 步骤。完成声明必须带 `## Verification` 段。跑后端测试前必须先切 node 22（默认 shell 是 node 14，jest 会假绿）。

**Goal:** Skills 引入显式 `kind: 'builtin' | 'github'` 分类字段贯穿后端→API→前端全链路，所有列表按该分类分组，移除弱推导字段 `domain`，并删除 text-summarize / text-translate 两个内置技能。

**Architecture:** `kind` 是 `source` 的派生字段，在 SkillDef 的两个构造点（磁盘扫描、DB 安装行）填充；`source` 原串保留供 GitHub 更新/重装解析。前端所有 `source === "builtin"` 判断与 `domain` 分组统一改为 `kind`。

**Tech Stack:** NestJS + Prisma（后端）、Next.js + TanStack Query + shadcn/ui（前端）、Jest。

**Spec:** docs/superpowers/specs/2026-06-13-skill-kind-classification-design.md

---

## Chunk 1: 后端

### Task 1: SkillDef 增 kind、删 domain

**Files:**
- Modify: `apps/backend/src/skills/skills.service.ts`
- Modify: `apps/backend/src/skills/skills.controller.ts:104-111`
- Modify: `apps/backend/src/commands/commands.controller.ts:20`
- Test: `apps/backend/src/skills/skills.service.spec.ts`
- Test fixtures: `apps/backend/src/skills/skill-store.seed.spec.ts:6`、`apps/backend/src/worker/agent.processor.spec.ts`（5 处 `domain: 'tvc'`）

- [ ] **Step 1: 在 skills.service.spec.ts 补失败断言**

在现有「内置技能」用例（:38-39 附近）和「github 安装」用例（:120 附近）各加一行：

```ts
expect(defs[0].kind).toBe('builtin');
// github 用例：
expect(d?.kind).toBe('github');
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest src/skills/skills.service.spec.ts
```
预期：FAIL（kind 为 undefined）。

- [ ] **Step 3: 改 SkillDef 与构造点**

`skills.service.ts`：

```ts
/** 技能分类：内置（随代码发布）或 GitHub 安装。 */
export type SkillKind = 'builtin' | 'github';

export interface SkillDef {
  name: string;
  description: string;
  /** 分类：'builtin' | 'github'，由 source 派生 */
  kind: SkillKind;
  /** 'builtin' 或 'github:...' 串 */
  source: 'builtin' | string;
  enabled: boolean;
  files: Record<string, string>;
}

const kindOf = (source: string): SkillKind =>
  source === 'builtin' ? 'builtin' : 'github';
```

- 删除 interface 中 `domain` 字段及其注释（原 :25-26）。
- `scanSkillDir` 的 push（原 :94-101）：删 `domain: ...` 行，加 `kind: kindOf(source)`。
- `buildInstalledMap` 两处（原 :133-140 磁盘消失分支、:151-158 正常分支）：删 `domain` 行，加 `kind: kindOf(row.source)`。

`skills.controller.ts` install 响应（原 :108）：`domain: ...` 改为 `kind: 'github' as const`（install 必来自 GitHub）。

`commands.controller.ts:20`：

```ts
.map(({ name, description, kind }) => ({ name, description, kind }));
```

测试 fixtures：`skill-store.seed.spec.ts:6` 的 `domain: 'g'` → `kind: 'builtin'`；`agent.processor.spec.ts` 5 处 `domain: 'tvc'` → `kind: 'builtin'`。

- [ ] **Step 4: 全量后端验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx tsc --noEmit && npx jest
```
预期：tsc 0 error；jest 全绿。若仍有 `domain` 残留编译错，按报错逐个清理（不得保留死字段）。

### Task 2: 删除两个内置技能

**Files:**
- Delete: `apps/backend/skills/text-summarize/`、`apps/backend/skills/text-translate/`
- Modify: `apps/backend/src/commands/parse-command.ts:1`（注释示例引用了被删技能）

- [ ] **Step 1: 删目录**

```bash
git rm -r apps/backend/skills/text-summarize apps/backend/skills/text-translate
```
（git rm 只暂存删除，不提交，符合 No auto-commit。）

- [ ] **Step 2: 更新注释示例**

`parse-command.ts:1` 的 `/text-translate 你好` 示例改用仍存在的技能，如 `/email-compose 周报`。

- [ ] **Step 3: 确认无残留引用**

```bash
grep -rn "text-summarize\|text-translate" apps/ --include='*.ts' --include='*.tsx' --include='*.md' | grep -v node_modules
```
预期：无输出。

## Chunk 2: 前端

### Task 3: 类型与全部使用点切换到 kind

**Files:**
- Modify: `apps/frontend/src/lib/api.ts:80-84`（CommandInfo）、`:204-211`（SkillInfo）
- Modify: `apps/frontend/src/app/settings/skills/_components/skill-list.tsx`
- Modify: `apps/frontend/src/app/settings/skills/_components/skill-detail-sheet.tsx:52-62`
- Modify: `apps/frontend/src/app/settings/skills/page.tsx:12`（注释）
- Modify: `apps/frontend/src/app/agent/_components/chat-thread.tsx:101-106`、`:289-296`
- Modify: `apps/frontend/src/app/agent/_components/chat-message.tsx:48`、`:80`

- [ ] **Step 1: api.ts 类型**

```ts
/** 技能分类：内置（随系统发布）或 GitHub 安装。与后端 SkillKind 对应。 */
export type SkillKind = "builtin" | "github";

export interface CommandInfo {
  name: string;
  description: string;
  kind: SkillKind;
}

/** 技能注册表条目（GET /skills）。kind==='builtin' 为内置（不可启停/删除）。 */
export interface SkillInfo {
  name: string;
  description: string;
  kind: SkillKind;
  source: "builtin" | string;
  enabled: boolean;
}
```

- [ ] **Step 2: skill-list.tsx**

- 顶部 import 增 `type SkillKind`（来自 `@/lib/api`）。
- 筛选（:87-88）改：`if (source === "builtin" && s.kind !== "builtin") return false; if (source === "github" && s.kind !== "github") return false;`
- 分组（:108-114）改为按 kind、Built-in 在前（与页面 Tabs 顺序一致）、组内按名称排序：

```ts
const KIND_LABEL: Record<SkillKind, string> = {
  builtin: "Built-in",
  github: "GitHub",
};
const KIND_ORDER: SkillKind[] = ["builtin", "github"];

const groups = new Map<SkillKind, SkillInfo[]>();
for (const s of filtered) {
  const list = groups.get(s.kind) ?? [];
  list.push(s);
  groups.set(s.kind, list);
}
const kinds = KIND_ORDER.filter((k) => groups.has(k));
```

渲染段把 `domains.map((domain) => ...)` 改为 `kinds.map((kind) => ...)`，组标题 `{KIND_LABEL[kind]}`，组内 `groups.get(kind)!.slice().sort((a, b) => a.name.localeCompare(b.name)).map(...)`。
- 卡片（:148）：`const isBuiltin = skill.kind === "builtin";`
- 文件头注释（:33）「domain 分组」改「分类（Built-in/GitHub）分组」。

- [ ] **Step 3: skill-detail-sheet.tsx**

- :52-53 徽章判断 `d.source === "builtin"` → `d.kind === "builtin"`；:62 同理。
- 删除 :55 的 `<Badge variant="outline">{d.domain}</Badge>`。

- [ ] **Step 4: chat-thread.tsx 补全面板**

- :101-105 分组改按 kind，固定顺序 builtin 在前：

```ts
const KIND_LABEL = { builtin: "Built-in", github: "GitHub" } as const;
const grouped = matches.reduce<Record<string, typeof matches>>((acc, c) => {
  (acc[c.kind] ??= []).push(c);
  return acc;
}, {});
const flat = (["builtin", "github"] as const).flatMap((k) => grouped[k] ?? []);
```

- 渲染（:292-295）：`Object.entries(grouped)` 改为按 `["builtin","github"]` 顺序遍历有内容的组，组标题 `{KIND_LABEL[kind]}`；注意 flat 顺序必须与渲染顺序一致（键盘导航依赖）。
- :289 注释「按 domain 分组」同步改。

- [ ] **Step 5: chat-message.tsx**

- :80 tooltip 的 `{command.domain}` 改 `{command.kind === "builtin" ? "Built-in" : "GitHub"}`；:48 注释同步。

- [ ] **Step 6: 前端静态验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/frontend && npx tsc --noEmit && npx next lint 2>/dev/null || npm run lint
```
预期：0 error。残留 `domain` 引用会在 tsc 暴露，逐个清理。

### Task 4: 端到端验证（preview）

- [ ] **Step 1: 停 PM2 前端、起 preview**

```bash
PM2_HOME=./.pm2 pm2 stop frontend
```
然后 preview_start（后端 3101 继续由 PM2 跑）。

- [ ] **Step 2: 验证 /settings/skills**

preview 打开 `/settings/skills`：列表只剩 Built-in（email-compose、marketing-strategist、tvc-director）与 GitHub 两组；text-summarize / text-translate 不再出现；徽章与筛选 Tabs 正常；preview_console_logs 无错误。截图留证。

- [ ] **Step 3: 验证聊天 `/` 补全**

进入 agent 对话页输入 `/`：补全面板按 Built-in / GitHub 分组、键盘上下移动与高亮顺序一致。截图留证。

- [ ] **Step 4: 恢复现场**

preview_resize 若改过视口则恢复 desktop；停 preview；`PM2_HOME=./.pm2 pm2 start frontend`。

- [ ] **Step 5: 汇报**

按 CLAUDE.md 输出 `## Verification` 段：tsc/jest/lint 命令与实际结果、关键 claim 的 file:line、preview 实测结论。
