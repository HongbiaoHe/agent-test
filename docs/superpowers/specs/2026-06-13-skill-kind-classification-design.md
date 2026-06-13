# Skills 分类（kind）全链路改造 — 设计

日期：2026-06-13
分支：feat/skills-sandbox-media-gen

## 目标

1. Skills 引入显式分类字段 `kind: 'builtin' | 'github'`，贯穿后端 → API → 前端的全部数据流转，替代散落各处的 `source === 'builtin'` 字符串判断。
2. 所有「列表」按该分类分组展示：设置页技能列表、聊天 `/` 命令补全面板。
3. 全链路移除弱推导字段 `domain`（名称首段），`kind` 成为唯一分类维度。
4. 删除内置 skills：`text-summarize`、`text-translate`（保留 email-compose、marketing-strategist、tvc-director）。

## 现状（已核实）

- `SkillDef`（apps/backend/src/skills/skills.service.ts:22-32）：`source: 'builtin' | string`，`domain` 由名称首段推导（:97、:136、:154）。
- `GET /commands`（apps/backend/src/commands/commands.controller.ts:20）回传 `{name, description, domain}`。
- 前端 `SkillInfo`（apps/frontend/src/lib/api.ts:204-211）含 `domain` + `source`；`CommandInfo`（:83）含 `domain`。
- 内置判断散落：skill-list.tsx:148、skill-detail-sheet.tsx:52-62、列表筛选 skill-list.tsx:87-88。
- 设置页列表按 `domain` 分组（skill-list.tsx:108-114）；`/` 补全面板按 `domain` 分组（chat-thread.tsx:101-103、292-295）；命令 chip hover 展示 `domain`（chat-message.tsx:80）。
- `text-summarize`/`text-translate` 仅被 parse-command.ts:1 的注释示例引用，删除目录无代码破坏。

## 设计决策（用户已确认）

- 删除范围：仅 text-summarize、text-translate 两个目录。
- 设置页列表：顶层只按 Built-in / GitHub 两组，组内按名称排序，去掉 domain 分组。
- domain 字段全链路移除；chip hover 与详情徽章改显示 Built-in / GitHub。
- `source` 原串保留（GitHub 技能更新/重装依赖 `github:repo#path@ref` 解析），`kind` 为派生字段，在 SkillDef 构造点（scanSkillDir、buildInstalledMap）填充。

## 改动面

### 后端
- `skills.service.ts`：SkillDef 增 `kind`、删 `domain`；两个构造点填充 kind。
- `skills.controller.ts`：install 响应中的 domain 推导（:108）改为 kind。
- `commands.controller.ts`：`/commands` 映射改回传 `kind`。
- 删除 `apps/backend/skills/text-summarize/`、`apps/backend/skills/text-translate/`。
- 受影响 spec 同步更新（skills.service.spec、agent.processor.spec、skill-store.seed.spec 中涉及 domain/这两个技能名的断言）。

### 前端
- `lib/api.ts`：SkillInfo / 详情 / CommandInfo 类型：增 `kind`、删 `domain`。
- `skill-list.tsx`：分组维度 domain → kind（Built-in / GitHub 两组）；`isBuiltin` 与来源筛选改用 kind。
- `skill-detail-sheet.tsx`：徽章判断改用 kind；删 domain 徽章。
- `page.tsx`（settings/skills）：注释同步；筛选语义不变（all/builtin/github）。
- `chat-thread.tsx`：补全面板分组 domain → kind，组标题显示 Built-in / GitHub。
- `chat-message.tsx`：chip hover 的 domain 改显示 kind。

## 验证

- 后端：node 22 下 `tsc` + jest（注意 memory：默认 shell node 14 会假绿）。
- 前端：`tsc` + lint（注意 react-hooks/set-state-in-effect 为 error 级）。
- 实际行为：preview 打开 /settings/skills 确认两组分组与徽章；聊天输入 `/` 确认补全面板按 Built-in/GitHub 分组；删除后的两个技能不再出现在列表与补全中。
- 测完恢复 desktop 视口；preview 前 pm2 stop frontend，测完恢复。
