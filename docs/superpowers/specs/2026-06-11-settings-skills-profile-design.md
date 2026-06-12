# Settings 页面：Skills 管理 + 用户信息 — 设计文档

日期：2026-06-11
状态：已确认（用户批准）

## 背景与目标

当前系统已有完整的 skills 后端接口（`GET /skills`、`POST /skills/install`、`PATCH /skills/:name`、`DELETE /skills/:name`，见 `apps/backend/src/skills/skills.controller.ts`）和一个孤立的前端 `/skills` 页面（列表 + GitHub 安装表单）。用户信息仅在 agent 侧栏底部显示邮箱，无资料页，无 settings 入口。

目标：

1. 新增统一的 `/settings` 入口（agent 侧栏底部齿轮按钮）。
2. Skills 管理模块迁入 settings 并扩展：搜索、筛选分组、详情查看、更新。
3. 新增 Profile 模块：账户只读展示 + passkey 管理。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| Settings 形态 | 独立 `/settings` 页面，嵌套路由（方案 A），左侧分区导航 |
| 入口位置 | agent 侧栏底部用户区域，lucide `Settings` 齿轮图标 |
| Skills 扩展范围 | 搜索 + 筛选 + 分组、详情查看、更新；不做内置 skill 启停 |
| Skill 详情形态 | Sheet 侧拉面板（非独立路由页） |
| Profile 范围 | 只读展示（email/注册时间/租户）+ passkey 管理（列表/添加/删除） |
| Passkey 删除策略 | 允许删到 0 个（邮箱登录兜底存在，不保护最后一个） |
| 旧 `/skills` 路由 | redirect 到 `/settings/skills` |

## 1. 路由与入口

```
apps/frontend/src/app/settings/
├── layout.tsx              # 设置外壳：返回按钮 + 左侧分区导航（Skills / Profile）
├── page.tsx                # /settings → redirect 到 /settings/skills
├── skills/
│   ├── page.tsx
│   └── _components/        # 从现有 /skills/_components 迁移并扩展
└── profile/
    ├── page.tsx
    └── _components/
```

- 入口：`conversation-sidebar.tsx` 底部用户区域新增齿轮按钮 → `/settings/skills`。
- 旧 `apps/frontend/src/app/skills/page.tsx` 改为 redirect 到 `/settings/skills`。
- 移动端：分区导航折叠为顶部 tabs（复用项目现有响应式模式，参考 `demo/template/`）。

## 2. Skills 模块

### 列表页（迁移现有 skill-list + install-form 并扩展）

- 顶部：搜索框（按 name/description 前端过滤）+ 来源筛选（All / Built-in / GitHub）。
- 按 domain 分组展示卡片。
- GitHub 安装表单保留（现有 `install-form.tsx` 迁移）。
- 卡片操作：启停 Switch、删除（两步确认，现状不变）、更新按钮（仅 GitHub skill）、点击卡片打开详情。

### 更新（后端零改动）

前端解析 skill 的 `source` 字符串（格式 `github:owner/repo#path@ref`），重新调用现有
`POST /skills/install`（已是幂等 upsert 语义）。

### 详情（Sheet 侧拉面板）

- 内容：SKILL.md 渲染（markdown）、文件清单、来源/domain/启用状态。
- 新后端接口：`GET /skills/:name`
  - 返回：`{ name, description, domain, source, enabled, files: string[], skillMd: string }`
  - 实现：复用 `SkillsService` 现有的 skill 文件加载逻辑（builtin 目录 / 用户安装目录）。
  - 同名遮蔽：用户安装 skill 与内置 skill 重名时，详情接口遵循 `listFor` 的解析优先级。
    注意：必须按 `listFor` 语义实现（包含 disabled skill），不能直接复用现有 `getFor`——
    它基于 `effectiveSkillsFor`，会排除 disabled skill，而管理页对 disabled skill 也要能开详情。
- 更新失败语义：重新安装失败（上游 repo/path/ref 已删除等）时，沿用现有 install 错误
  处理 + 全局 toast；磁盘上的旧 skill 必须保持原样不被破坏（计划阶段需为此加测试）。
  已知边界：`skill-installer.ts` 在 rename 前会 `rmSync(finalDest)`，若 rename 与
  cp 兜底同时失败旧 skill 会丢失——主要失败模式都发生在 tmp 阶段之前，不阻塞；
  测试覆盖到该边界时可能需要对 installer 做小调整。

## 3. Profile 模块

### 账户卡片（只读）

email、注册时间、租户。

### Passkey 管理卡片

- 列出已注册 passkey：创建时间、transports。
- 添加新 passkey：登录态专用流程（见下）。现有 `POST /auth/passkey/register/options|verify`
  无鉴权且 email 由客户端传入（`passkey.controller.ts` / `passkey.service.ts` 的
  `findOrCreateByEmail`），不能直接复用——登录用户可能把 passkey 挂到他人账户。
- 删除 passkey。

### 新后端接口（新建 `apps/backend/src/users/` 模块）

- `GET /users/me` → `{ email, createdAt, tenantName, passkeys: [{ id, createdAt, transports }] }`
  （`tenantId` 是 cuid 不可读，改为 join `Tenant.name` 返回 `tenantName`，UI 展示该值；
  `Authenticator.transports` 在 DB 中是可空的逗号拼接字符串，响应中可为 null，前端需自行 split）
- `DELETE /users/me/passkeys/:id`
- `POST /users/me/passkeys/options` → 生成注册 challenge。**userId 从 JWT 取**，
  不接受任何客户端传入的 email/userId；内部复用 `PasskeyService` 现有 challenge 生成逻辑。
  返回 WebAuthn registration options。
- `POST /users/me/passkeys/verify` → 入参 WebAuthn attestation response；校验后将凭据
  写入该 JWT 用户的 `Authenticator` 表。返回新增的 `{ id, createdAt, transports }`。

均挂 JWT guard，按 userId 隔离。

## 4. 设计系统约束

- 语义 token only（`bg-background` / `text-muted-foreground` 等），无硬编码颜色，明暗双模式均须成立。
- 复用 shadcn/ui 现有组件：Card / Sheet / Tabs / Switch / Badge / Input / Button / Skeleton / Separator。
- 图标：lucide-react。
- UI 文案：英文（沿用全英文化方向）。
- 对照参考实现 `apps/frontend/src/app/demo/template/`。

## 5. 数据流与错误处理

- 前端统一走 `apps/frontend/src/lib/api.ts` 的 `request()` 层（自动带 token、解析
  `{code, message, data}` 信封、code !== 0 抛错 + 全局 toast）。
- TanStack Query：`useQuery` 拉取，`useMutation` 变更后 invalidate。
- 详情/列表加载态用 Skeleton，错误态沿用现有模式（toast + 内联提示）。

## 6. 测试与验证

- 后端：新接口（`GET /skills/:name`、`GET /users/me`、`DELETE /users/me/passkeys/:id`）jest 测试；
  跑测试前先切 node 22（默认 shell node 14 会假绿）。
- 前端：`tsc` + lint 通过；preview 实际走通：设置入口 → skills 搜索/筛选/详情/更新 → profile 展示 / passkey 列表；明暗两种模式各截图验证；测完恢复 desktop 视口。

## 非目标（YAGNI）

- 内置 skill 的启停。
- 用户昵称/头像编辑（需要 DB migration，未要求）。
- Skill 市场 / 浏览发现功能。
- 主题切换迁入 settings（侧栏已有）。
