# Passkey 邮箱绑定提示 + 注册信息展示 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 settings 添加 passkey 时提示绑定邮箱不可更改，并让每行 passkey 展示来源名称 / 设备类型 / 备份状态 / 添加时间 / 最后使用时间。

**Architecture:** 后端 `Authenticator` 表加 4 个元数据字段（aaguid / deviceType / backedUp / lastUsedAt），注册落库时从 `@simplewebauthn/server` 的 `registrationInfo` 写入、登录验证时刷新 `lastUsedAt`；新增纯函数模块把 aaguid 解析成厂商名（命中映射或按 deviceType 兜底）。`/users/me` 把字段连同解析好的 `providerName` 一起回传，前端不做映射。前端 passkey 管理卡加一个内联确认区（沿用本文件已有的两步确认风格），并升级 row 展示。

**Tech Stack:** NestJS + Prisma(MySQL) + `@simplewebauthn/server@13` / Next.js + React Query + `@simplewebauthn/browser@13` + shadcn/ui。

**Spec:** `docs/superpowers/specs/2026-06-13-passkey-email-binding-and-info-design.md`

---

## 关键前置须知（执行前必读）

- **跑后端测试前必须确认 node 版本**：默认 shell 可能是 node 14，jest 会静默崩溃且 exit 0（假绿）。每条 jest 命令前置：
  ```bash
  export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
  ```
  本机当前已是 v22.21.1，但仍按上面前置以防漂移。
- **不自动 git 操作**：本计划每个 Task 末尾的 commit step 仍需执行（这是计划内的原子提交），但**不要 push、不要合并**。
- **SimpleWebAuthn v13 字段已确认**（`node_modules/@simplewebauthn/server/.../verifyRegistrationResponse.d.ts:67-73`）：`registrationInfo.aaguid: string`、`registrationInfo.credentialDeviceType: 'singleDevice' | 'multiDevice'`、`registrationInfo.credentialBackedUp: boolean`。
- **前端是改版 Next.js**：写前端代码前若涉及不确定 API，先读 `apps/frontend/node_modules/next/dist/docs/`（见 `apps/frontend/AGENTS.md`）。本计划前端改动只用既有组件，不引入新 Next API。

---

## Chunk 1: 后端数据层与厂商名解析

### Task 1: Authenticator 表加元数据字段 + 迁移

**Files:**
- Modify: `apps/backend/prisma/schema.prisma:28-40`
- Generate: `apps/backend/prisma/migrations/<timestamp>_add_passkey_metadata/`

- [ ] **Step 1: 改 schema，给 Authenticator 加 4 字段**

把 `apps/backend/prisma/schema.prisma` 的 `Authenticator` 模型改成（仅在 `transports` 行后、`createdAt` 行前后插入新字段）：

```prisma
/** WebAuthn/Passkey 凭据（一个用户可注册多把）。 */
model Authenticator {
  id           String   @id @default(cuid())
  credentialId String   @unique // base64url 编码的 credential ID，登录时按此查找
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  publicKey    Bytes // COSE 公钥
  counter      Int      @default(0) // 签名计数器，防重放
  transports   String? // 逗号拼接，如 "internal,hybrid"
  aaguid       String? // 认证器厂商标识（注册时由 WebAuthn 返回），用于解析来源名
  deviceType   String? // singleDevice | multiDevice（来自 credentialDeviceType）
  backedUp     Boolean  @default(false) // 是否云同步备份（来自 credentialBackedUp）
  lastUsedAt   DateTime? // 最后一次用此 passkey 登录的时间；从未使用为 null
  createdAt    DateTime @default(now())

  @@index([userId])
}
```

- [ ] **Step 2: 生成并应用迁移**

确认本机 MySQL 在跑、`apps/backend/.env` 的 `DATABASE_URL` 可用，然后：

Run:
```bash
cd apps/backend && npx prisma migrate dev --name add_passkey_metadata
```
Expected: 新建 `migrations/<timestamp>_add_passkey_metadata/migration.sql`，包含 `ALTER TABLE` 加四列；命令以 `Your database is now in sync with your schema.` 结束，并自动 `prisma generate`。

> 若 MySQL 不可用导致 migrate 失败：停下来告知用户，不要伪造迁移文件。

- [ ] **Step 3: 确认 Prisma Client 类型已更新**

Run:
```bash
cd apps/backend && npx prisma generate
```
Expected: 成功；后续代码里 `authenticator.aaguid/deviceType/backedUp/lastUsedAt` 有类型。

- [ ] **Step 4: Commit**

```bash
git add apps/backend/prisma/schema.prisma apps/backend/prisma/migrations
git commit -m "feat(db): Authenticator 加 aaguid/deviceType/backedUp/lastUsedAt 字段"
```

---

### Task 2: aaguid → 厂商名解析（纯函数 + 测试，TDD）

**Files:**
- Create: `apps/backend/src/auth/aaguid-map.ts`
- Test: `apps/backend/src/auth/aaguid-map.spec.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/backend/src/auth/aaguid-map.spec.ts`：

```ts
import { resolveProviderName } from './aaguid-map';

describe('resolveProviderName', () => {
  it('已知 aaguid 命中厂商名（iCloud 钥匙串）', () => {
    expect(
      resolveProviderName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd', 'multiDevice'),
    ).toBe('iCloud 钥匙串');
  });

  it('已知 aaguid 命中厂商名（Google 密码管理器）', () => {
    expect(
      resolveProviderName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'multiDevice'),
    ).toBe('Google 密码管理器');
  });

  it('未知 aaguid + multiDevice → 云同步兜底', () => {
    expect(resolveProviderName('11111111-2222-3333-4444-555555555555', 'multiDevice')).toBe(
      '云同步 passkey',
    );
  });

  it('未知 aaguid + singleDevice → 设备兜底', () => {
    expect(resolveProviderName('11111111-2222-3333-4444-555555555555', 'singleDevice')).toBe(
      '设备 passkey',
    );
  });

  it('全零 aaguid（认证器未透露）按 deviceType 兜底', () => {
    expect(resolveProviderName('00000000-0000-0000-0000-000000000000', 'multiDevice')).toBe(
      '云同步 passkey',
    );
  });

  it('aaguid/deviceType 均缺失 → 通用兜底', () => {
    expect(resolveProviderName(null, null)).toBe('Passkey');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest aaguid-map -- --silent=false
```
Expected: FAIL（`Cannot find module './aaguid-map'`）。

- [ ] **Step 3: 写实现**

创建 `apps/backend/src/auth/aaguid-map.ts`：

```ts
/**
 * 把 WebAuthn 注册返回的 aaguid（认证器厂商标识）解析成展示用来源名。
 * 命中内置常见厂商表则返回品牌名；未命中按 deviceType 兜底（云同步 / 单设备）。
 * 仅收录常见的几家，YAGNI：不引入完整 AAGUID 数据集。
 */
const AAGUID_NAMES: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 钥匙串',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a5': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7be': 'Dashlane',
};

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export function resolveProviderName(
  aaguid: string | null,
  deviceType: string | null,
): string {
  if (aaguid && aaguid !== ZERO_AAGUID) {
    const name = AAGUID_NAMES[aaguid.toLowerCase()];
    if (name) return name;
  }
  if (deviceType === 'multiDevice') return '云同步 passkey';
  if (deviceType === 'singleDevice') return '设备 passkey';
  return 'Passkey';
}
```

> 注：示例里 Dashlane 那行 aaguid 是占位，执行时若不确定就删掉该行——它不影响测试（测试不覆盖 Dashlane）。其余几个 aaguid 为社区公开值。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest aaguid-map -- --silent=false
```
Expected: PASS，6 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth/aaguid-map.ts apps/backend/src/auth/aaguid-map.spec.ts
git commit -m "feat(auth): 新增 aaguid→厂商名解析（命中映射或按 deviceType 兜底）"
```

---

### Task 3: 注册落库写入元数据 + 登录刷新 lastUsedAt

**Files:**
- Modify: `apps/backend/src/auth/passkey.service.ts:99-137`（注册落库）
- Modify: `apps/backend/src/auth/passkey.service.ts:215-218`（登录更新）
- Modify: `apps/backend/src/auth/passkey.service.ts:1-17`（import）

> 本服务无既有单测（依赖 redis + @simplewebauthn 难以有意义地单测），与现状一致不新增服务级 spec；正确性由 Task 2 单测 + 编译 + Task 6 的前端实跑链路覆盖。

- [ ] **Step 1: import resolveProviderName**

在 `passkey.service.ts` 顶部 import 区（`AuthService` import 后）加：

```ts
import { resolveProviderName } from './aaguid-map';
```

- [ ] **Step 2: 注册落库时写入新字段，并返回 enriched 行**

把 `verifyRegistrationForUser` 末尾的 `create` + return（当前 126-136 行）改为：

```ts
    const row = await this.prisma.authenticator.create({
      data: {
        credentialId: info.credential.id,
        userId,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: (response.response.transports ?? []).join(',') || null,
        // v13 registrationInfo 里这三个字段都是非可空（aaguid:string / credentialDeviceType / credentialBackedUp:boolean）
        aaguid: info.aaguid,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      },
    });
    await this.redis.del(`webauthn:reg:${userId}`);
    return {
      id: row.id,
      createdAt: row.createdAt,
      transports: row.transports,
      providerName: resolveProviderName(row.aaguid, row.deviceType),
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      lastUsedAt: row.lastUsedAt,
    };
```

- [ ] **Step 3: 登录验证成功时刷新 lastUsedAt**

把 `verifyAuthentication` 里更新 counter 的那次 update（当前 215-218 行）改为同时写 `lastUsedAt`：

```ts
    await this.prisma.authenticator.update({
      where: { credentialId: cred.credentialId },
      data: { counter: newCounter, lastUsedAt: new Date() },
    });
```

- [ ] **Step 4: 类型检查**

Run:
```bash
cd apps/backend && npx tsc --noEmit -p tsconfig.json
```
Expected: 无错误（`info.aaguid` 等字段在 v13 类型中存在；`row.aaguid` 等在 Task 1 generate 后存在）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth/passkey.service.ts
git commit -m "feat(auth): 注册落库写入 aaguid/deviceType/backedUp，登录刷新 lastUsedAt"
```

---

### Task 4: /users/me 回传 enriched passkeys（含测试，TDD）

**Files:**
- Modify: `apps/backend/src/users/users.service.ts:11-30`
- Modify: `apps/backend/src/users/users.service.spec.ts:10-33`

- [ ] **Step 1: 改失败测试**

把 `users.service.spec.ts` 的 `getMe` 用例（10-33 行）整段替换为：

```ts
describe('UsersService.getMe', () => {
  it('返回 email/createdAt/tenantName + enriched passkeys（providerName/deviceType/backedUp/lastUsedAt）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      createdAt: new Date('2026-01-01'),
      tenant: { name: 'a@b.c' },
      authenticators: [
        {
          id: 'pk1',
          createdAt: new Date('2026-02-02'),
          transports: 'internal,hybrid',
          aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
          deviceType: 'multiDevice',
          backedUp: true,
          lastUsedAt: new Date('2026-04-04'),
        },
        {
          id: 'pk2',
          createdAt: new Date('2026-03-03'),
          transports: null,
          aaguid: null,
          deviceType: 'singleDevice',
          backedUp: false,
          lastUsedAt: null,
        },
      ],
    });
    const svc = new UsersService(prismaMock as never);
    const me = await svc.getMe('u1');
    expect(me.email).toBe('a@b.c');
    expect(me.tenantName).toBe('a@b.c');
    expect(me.passkeys[0]).toEqual({
      id: 'pk1',
      createdAt: new Date('2026-02-02'),
      transports: 'internal,hybrid',
      providerName: 'iCloud 钥匙串',
      deviceType: 'multiDevice',
      backedUp: true,
      lastUsedAt: new Date('2026-04-04'),
    });
    expect(me.passkeys[1].providerName).toBe('设备 passkey');
    expect(me.passkeys[1].lastUsedAt).toBeNull();
    // 回传对象不含 aaguid 原始值——aaguid 只用于后端解析成 providerName，
    // 也不泄漏 publicKey/counter/credentialId 等内部列
    expect(Object.keys(me.passkeys[0]).sort()).toEqual([
      'backedUp',
      'createdAt',
      'deviceType',
      'id',
      'lastUsedAt',
      'providerName',
      'transports',
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest users.service -- --silent=false
```
Expected: FAIL（当前 getMe 只回 id/createdAt/transports）。

- [ ] **Step 3: 写实现**

`users.service.ts` 顶部 import 区加：

```ts
import { resolveProviderName } from '../auth/aaguid-map';
```

把 `getMe` 的 return（19-29 行）的 `passkeys` 映射改为：

```ts
      passkeys: user.authenticators.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        transports: a.transports,
        // aaguid 仅用于解析来源名，不直接外泄
        providerName: resolveProviderName(a.aaguid, a.deviceType),
        deviceType: a.deviceType,
        backedUp: a.backedUp,
        lastUsedAt: a.lastUsedAt,
      })),
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest users.service -- --silent=false
```
Expected: PASS。

- [ ] **Step 5: 后端整体类型检查 + 全量测试**

Run:
```bash
cd apps/backend && npx tsc --noEmit -p tsconfig.json
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"
cd apps/backend && npx jest -- --silent=false
```
Expected: tsc 无错误；jest 全绿（确认没有别处依赖旧的 getMe 形状）。

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/users/users.service.ts apps/backend/src/users/users.service.spec.ts
git commit -m "feat(users): /users/me 回传 providerName/deviceType/backedUp/lastUsedAt"
```

---

## Chunk 2: 前端类型与 UI

### Task 5: 前端 MyPasskey 类型扩展

**Files:**
- Modify: `apps/frontend/src/lib/api.ts:321-326`

- [ ] **Step 1: 扩展 MyPasskey 接口**

把 `api.ts` 的 `MyPasskey` 接口（321-326 行）改为：

```ts
/** 已注册 passkey。transports 为逗号拼接串可为 null；providerName 由后端解析。 */
export interface MyPasskey {
  id: string;
  createdAt: string;
  transports: string | null;
  /** 后端按 aaguid 解析出的来源名，如 "iCloud 钥匙串"；兜底 "云同步 passkey" / "设备 passkey" / "Passkey"。 */
  providerName: string;
  /** "singleDevice" | "multiDevice" | null */
  deviceType: string | null;
  backedUp: boolean;
  /** 最后一次用此 passkey 登录的时间；从未使用为 null。 */
  lastUsedAt: string | null;
}
```

> `myPasskeyVerify` 返回类型已是 `Promise<MyPasskey>`（api.ts:347-349），后端 Task 3 已让 verify 返回同一形状，无需再改。

- [ ] **Step 2: 类型检查**

Run:
```bash
cd apps/frontend && npx tsc --noEmit
```
Expected: 报错指向 `passkeys-card.tsx`（消费 MyPasskey 处需补字段渲染）——这是预期，Task 6 修。若 `api.ts` 本身无报错即说明接口写对了。

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/api.ts
git commit -m "feat(api): MyPasskey 加 providerName/deviceType/backedUp/lastUsedAt"
```

---

### Task 6: PasskeysCard 内联确认面板 + row 信息升级

**Files:**
- Modify: `apps/frontend/src/app/settings/profile/_components/passkeys-card.tsx`（全量改写，165 行 → 见下）

设计要点：
- 「Add passkey」点击不再直接 `addMut.mutate()`，而是先把 `confirming` 置 true，在卡片内容区顶部展开一个内联确认区（沿用本文件 PasskeyRow 删除用的两步确认风格），文案含**当前邮箱**（取自同一个 `getMe` query 的 `query.data.email`），按钮「确认添加 / 取消」。确认才走注册。
- row 展示：主标题 `providerName`；副行用 lucide 图标 + Badge 表达「云同步 / 单设备」「已备份」，以及 `Added 日期` 与 `Last used 日期 / 从未使用`。
- 仅用既有 shadcn 原语（Button/Badge/Card/Skeleton）与语义 token，不硬编码颜色，不引入新依赖。

- [ ] **Step 1: 改写组件**

把 `apps/frontend/src/app/settings/profile/_components/passkeys-card.tsx` 整文件替换为：

```tsx
"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteMyPasskey,
  getMe,
  myPasskeyOptions,
  myPasskeyVerify,
  type MyPasskey,
} from "@/lib/api";

import { ME_QUERY_KEY } from "./account-card";

/** Passkey 管理：列表 / 添加（先内联确认绑定邮箱，再走 WebAuthn 注册）/ 删除（两步确认）。 */
export function PasskeysCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: getMe });
  const [confirmingAdd, setConfirmingAdd] = useState(false);

  const addMut = useMutation({
    mutationFn: async () => {
      const options = await myPasskeyOptions();
      // 用户在系统弹窗取消时 startRegistration 抛 NotAllowedError，
      // 由 mutation 错误态接住，与其他失败一致展示
      const response = await startRegistration({ optionsJSON: options });
      return myPasskeyVerify(response);
    },
    onSuccess: () => {
      setConfirmingAdd(false);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });

  const email = query.data?.email;
  const passkeys = query.data?.passkeys ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Passkeys</CardTitle>
          <CardDescription>
            Sign in with Touch ID, Windows Hello, or a security key.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={addMut.isPending || confirmingAdd || !email}
          onClick={() => {
            addMut.reset();
            setConfirmingAdd(true);
          }}
        >
          <Plus className="size-4" />
          Add passkey
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirmingAdd && (
          <div className="space-y-3 rounded-lg border border-primary/40 bg-accent/40 px-3 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Add a passkey for this account
              </p>
              <p className="text-sm text-muted-foreground">
                This passkey will be bound to{" "}
                <span className="font-medium text-foreground">{email}</span>.
                The account can&apos;t be changed.
              </p>
            </div>
            {addMut.isError && (
              <p className="text-sm text-destructive" role="alert">
                {addMut.error instanceof Error
                  ? addMut.error.message
                  : "Failed to add passkey"}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                disabled={addMut.isPending}
                onClick={() => addMut.mutate()}
              >
                {addMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Confirm &amp; continue
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={addMut.isPending}
                onClick={() => {
                  addMut.reset();
                  setConfirmingAdd(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {query.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : query.isError ? (
          // 错误细节由同页 AccountCard（同 query）展示，这里只给中性占位避免误导性空态
          <p className="py-2 text-sm text-muted-foreground">
            Could not load passkeys.
          </p>
        ) : passkeys.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No passkeys yet — add one to sign in without a password.
          </p>
        ) : (
          passkeys.map((pk) => <PasskeyRow key={pk.id} passkey={pk} />)
        )}
      </CardContent>
    </Card>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function PasskeyRow({ passkey }: { passkey: MyPasskey }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const deleteMut = useMutation({
    mutationFn: () => deleteMyPasskey(passkey.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });

  const isSynced = passkey.deviceType === "multiDevice";

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-sm font-medium">{passkey.providerName}</p>
          <div className="flex flex-wrap items-center gap-1">
            {passkey.deviceType && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Smartphone className="size-3" />
                {isSynced ? "Synced" : "Single device"}
              </Badge>
            )}
            {passkey.backedUp && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <ShieldCheck className="size-3" />
                Backed up
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>Added {fmtDate(passkey.createdAt)}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {passkey.lastUsedAt
                ? `Last used ${fmtDate(passkey.lastUsedAt)}`
                : "Never used"}
            </span>
          </div>
          {deleteMut.isError && (
            <p className="text-xs text-destructive" role="alert">
              {deleteMut.error instanceof Error
                ? deleteMut.error.message
                : "Failed to delete passkey"}
            </p>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteMut.isPending}
            onClick={() => deleteMut.mutate()}
          >
            {deleteMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Confirm delete"
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleteMut.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete passkey"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}
```

> 改动相对原文件：① 标题旁的「Add passkey」按钮改为先开内联确认区；② 错误提示从卡片顶部移进确认区内；③ 新增确认区块；④ PasskeyRow 主标题改 `providerName`、加设备类型/备份 Badge 与 Added/Last used 两个时间。删除两步确认逻辑保持不变。

- [ ] **Step 2: 类型检查**

Run:
```bash
cd apps/frontend && npx tsc --noEmit
```
Expected: 无错误（确认 lucide 这些图标名都存在：Clock/KeyRound/Plus/ShieldCheck/Smartphone/Trash2/Loader2）。

- [ ] **Step 3: lint**

Run:
```bash
cd apps/frontend && npx eslint src/app/settings/profile/_components/passkeys-card.tsx
```
Expected: 无 error（注意 react-hooks/set-state-in-effect 等规则；本组件没在 effect 里 setState）。

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/app/settings/profile/_components/passkeys-card.tsx
git commit -m "feat(settings): 添加 passkey 内联确认绑定邮箱 + row 展示来源/类型/备份/时间"
```

---

## Final Verification（端到端实跑，必做）

> 遵循 CLAUDE.md：claim「完成」前必须实跑功能，tsc 干净不算。

- [ ] **Step 1: 起 dev server**

注意 memory：3100/3101 由 PM2 守护，会被秒拉起。用 preview 前先 `pm2 stop frontend`（用 `PM2_HOME=./.pm2`），收尾再恢复。优先用 preview_start 起预览。

- [ ] **Step 2: 注册路径实跑**

登录到 `/settings/profile`：
1. 点「Add passkey」→ 确认出现内联确认区，文案显示**当前登录邮箱**，账户不可更改。
2. 点「Confirm & continue」→ 弹系统 passkey 框 → 完成 → 列表出现新 row。
3. 新 row 显示：来源名（如「iCloud 钥匙串」或兜底名）、Synced/Single device Badge、（若备份）Backed up Badge、Added 今天、Last used 显示「Never used」。
4. 点「Cancel」能收起确认区不触发注册。

- [ ] **Step 3: 登录刷新 lastUsedAt 实跑**

登出 → 用刚注册的邮箱走 passkey 登录 → 回到 `/settings/profile` → 该 row 的「Last used」从「Never used」变为今天日期。

- [ ] **Step 4: 收尾**

- preview 改过 viewport 的话恢复 desktop preset。
- 恢复 PM2：`PM2_HOME=./.pm2 pm2 start frontend`（或按本机实际进程名）。

- [ ] **Step 5: 汇总 Verification 段**

按 CLAUDE.md 在完成消息里写 `## Verification`，逐条贴：tsc 命令结果、jest 结果（含 node 22 前置）、上面 Step 2/3 的实际观察。
```
