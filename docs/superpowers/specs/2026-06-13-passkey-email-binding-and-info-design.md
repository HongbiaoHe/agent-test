# Passkey 邮箱绑定提示 + 注册信息展示

日期：2026-06-13
状态：已确认，待实现

## 背景

邮箱是所有登录方式的唯一绑定标识（`User.email` 唯一索引），既可邮箱登录也可 passkey 登录，注册暂不做邮箱验证（`findOrCreateByEmail` 直接查/建）。这些绑定逻辑已在代码中实现。

本次只补两块缺口：

1. settings 里点「Add passkey」时，提醒用户当前绑定邮箱（账户不可更改），确认后再注册。
2. Passkey row item 展示更多注册信息，让用户能区分多个 passkey。

## 现状（关键文件）

- 数据模型：`apps/backend/prisma/schema.prisma` — `Authenticator` 现存 `credentialId / publicKey / counter / transports / createdAt`
- 后端 passkey 全流程：`apps/backend/src/auth/passkey.service.ts`
- 登录态添加/删除 passkey 接口：`apps/backend/src/users/users.controller.ts`、`users.service.ts`，`/users/me` 现只回传 `id / createdAt / transports`
- 前端 API：`apps/frontend/src/lib/api.ts`（`MyPasskey`、`getMe`、`myPasskeyOptions/Verify`、`deleteMyPasskey`）
- 前端 passkey 管理 UI：`apps/frontend/src/app/settings/profile/_components/passkeys-card.tsx`
- WebAuthn 库：后端 `@simplewebauthn/server@^13.3.1`，前端 `@simplewebauthn/browser@^13.3.0`

## 设计

### 1. 数据层（Prisma）

`Authenticator` 新增 4 字段：

- `aaguid String?` — 认证器厂商标识，注册时由 WebAuthn 返回
- `deviceType String?` — `"singleDevice"` / `"multiDevice"`（来自 `credentialDeviceType`）
- `backedUp Boolean @default(false)` — 是否云同步备份（来自 `credentialBackedUp`）
- `lastUsedAt DateTime?` — 最后一次用此 passkey 登录的时间

需要一次 migration。存量 passkey 这些字段为空/默认，row 上走兜底展示。

### 2. 后端逻辑（passkey.service.ts）

- 注册落库时（`verifyRegistration` + `verifyRegistrationForUser`）：从 `verifyRegistrationResponse` 的 `registrationInfo` 取 `aaguid / credentialDeviceType / credentialBackedUp` 一起写入。
- 登录验证时（`verifyAuthentication`）：更新该凭证 `lastUsedAt = now`。
- AAGUID → 来源名称映射：新增小模块 `aaguid-map.ts`，内置常见厂商映射（iCloud 钥匙串 / Google 密码管理器 / Windows Hello / 1Password / Bitwarden 等）。命中返回名称；未命中按 `deviceType` 兜底（多设备→「云同步 passkey」、单设备→「设备 passkey」）。名称在 `/users/me` 里解析好再回传，前端不做映射。

### 3. 接口（/users/me）

`MyPasskey` 返回结构扩展为：

```
{ id, createdAt, transports,
  providerName,   // 后端解析好的来源名
  deviceType,     // single / multi
  backedUp,       // bool
  lastUsedAt }    // 可能为 null（从未使用）
```

### 4. 前端 — 添加时的内联确认面板（passkeys-card.tsx）

点「Add passkey」不再直接弹系统框，而是在按钮区上方展开内联面板（复用/对齐项目现有的通用审批面板风格，见 commit 31c6c8e）：

> 「将为 **当前邮箱 your@email.com** 添加一个 passkey，账户绑定不可更改。」
> 按钮：`确认添加` / `取消`

点「确认添加」才走 `myPasskeyOptions → startRegistration → myPasskeyVerify`。邮箱从 `getMe()` 已有数据只读读取展示。

### 5. 前端 — Passkey row item 信息展示

每行从「图标 + Added 日期 + transports 徽章」升级为：

- 主标题：`providerName`（如「iCloud 钥匙串」）
- 副行：设备类型徽章（「云同步」/「单设备」）+ 备份状态 + `Added 日期` + `Last used 日期`（无则「从未使用」）
- 右侧删除按钮保持两步确认不变

遵循设计系统语义 token，lucide 图标，复用 shadcn 原语（Badge 等）。

## 验证方式

- 后端：`tsc` + 现有 passkey 相关测试（跑前切 node 22）
- 前端：起 dev server，在 `/settings/profile` 实际走一遍——点 Add passkey 看到确认面板→确认→注册成功→row 显示来源名/类型/时间；再 passkey 登录一次看 Last used 是否刷新

## 范围外（YAGNI）

- 用户可编辑的 passkey 备注名（`name` 字段 + 重命名交互）
- credentialId 片段 / counter 等技术信息展示
- 邮箱验证流程
