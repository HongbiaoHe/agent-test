# Settings（Skills 管理 + Profile）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/settings` 入口与外壳，迁移并扩展 Skills 管理模块（搜索/筛选分组/详情/更新），新增 Profile 模块（账户只读展示 + passkey 管理）。

**Architecture:** 后端在现有 `skills` 模块加一个详情接口、新建 `users` 模块（me + passkey 管理，复用重构后的 `PasskeyService`）；前端新建 `/settings` 嵌套路由（layout + skills + profile），旧 `/skills` 改 redirect，agent 侧栏底部加齿轮入口。

**Tech Stack:** NestJS + Prisma + class-validator + jest（后端）；Next.js 16 app router + TanStack Query + shadcn/ui + @simplewebauthn/browser（前端）。

**Spec:** `docs/superpowers/specs/2026-06-11-settings-skills-profile-design.md`

---

## ⚠️ 全局规则（来自 CLAUDE.md，覆盖本计划模板的默认行为）

1. **禁止自动 commit**。每个 Task 结尾的 "Checkpoint" 步骤只做验证 + 停下来，不执行任何 git 写操作。所有变更留在工作区，由用户审查后自行决定提交。
2. **跑后端测试 / tsc 前必须先切 node 22**（默认 shell 是 node 14，jest 会静默崩溃且 exit 0，假绿）：

   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
   node -v   # 必须输出 v22.21.1，否则停下排查
   ```

   下文所有 `Run:` 命令均假设已在当前 shell 执行过上面两行。
3. **前端写代码前**：本项目 Next.js 为新版本（见 `apps/frontend/AGENTS.md`），涉及不熟悉的 API（如 `redirect`）先查 `apps/frontend/node_modules/next/dist/docs/` 对应文档。已知约束：`useEffect` 里禁止同步 `setState`（`react-hooks/set-state-in-effect` 是 error 级）。
4. **UI 规则**：语义 token only（禁止 `zinc-*`/hex），lucide-react 图标，shadcn/ui 组件组合，明暗双模式都要成立。UI 文案用英文。
5. 任何"完成"声明必须带 `## Verification` 段（命令 + 实际输出 + file:line 引用）。

---

## Chunk 1: Backend

### Task 1: SkillsService 详情方法 `detailFor`

让列表（`listFor`）与详情共享同一份合并逻辑（含 disabled、用户安装遮蔽内置），避免两处语义漂移。

**Files:**
- Modify: `apps/backend/src/skills/skills.service.ts`（重构 `listFor`，新增 `mergedMapFor` + `detailFor`）
- Test: `apps/backend/src/skills/skills.service.spec.ts`

- [ ] **Step 1.1: 写失败测试**

在 `skills.service.spec.ts` 现有 describe 同级追加（沿用文件顶部已有的 `makeSkill` / `prismaMock` 工具）：

```ts
describe('SkillsService.detailFor', () => {
  let builtinDir: string;
  let dataDir: string;
  let svc: SkillsService;

  beforeEach(() => {
    builtinDir = mkdtempSync(join(tmpdir(), 'builtin-'));
    dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    process.env.SKILLS_DIR = builtinDir;
    process.env.SKILLS_DATA_DIR = dataDir;
    svc = new SkillsService(prismaMock as never);
  });
  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('返回内置技能详情（files 列表 + skillMd 原文）', async () => {
    makeSkill(builtinDir, 'docx', '内置版');
    writeFileSync(join(builtinDir, 'docx', 'ref.md'), 'extra');
    prismaMock.skill.findMany.mockResolvedValue([]);
    const d = await svc.detailFor('u1', 'docx');
    expect(d?.source).toBe('builtin');
    expect(d?.files.sort()).toEqual(['SKILL.md', 'ref.md']);
    expect(d?.skillMd).toContain('description: 内置版');
  });

  it('disabled 的安装技能也能查详情（listFor 语义，而非 effectiveSkillsFor）', async () => {
    makeSkill(join(dataDir, 'u1'), 'pdf', 'x');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'pdf', enabled: false, source: 'github:a/b#p@main' },
    ]);
    const d = await svc.detailFor('u1', 'pdf');
    expect(d?.enabled).toBe(false);
    expect(d?.source).toBe('github:a/b#p@main');
  });

  it('同名时用户安装遮蔽内置，与 listFor 一致', async () => {
    makeSkill(builtinDir, 'docx', '内置版');
    makeSkill(join(dataDir, 'u1'), 'docx', '安装版');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'docx', enabled: true, source: 'github:a/b#p@main' },
    ]);
    const d = await svc.detailFor('u1', 'docx');
    expect(d?.description).toBe('安装版');
  });

  it('不存在的技能返回 undefined', async () => {
    prismaMock.skill.findMany.mockResolvedValue([]);
    expect(await svc.detailFor('u1', 'nope')).toBeUndefined();
  });
});
```

注意：`writeFileSync` 需确认已在文件头部 import（现有头部已有，见 `skills.service.spec.ts:1`）。

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cd apps/backend && npx jest src/skills/skills.service.spec.ts -t detailFor`
Expected: FAIL，报 `svc.detailFor is not a function`

- [ ] **Step 1.3: 实现**

在 `skills.service.ts` 中：

a) 新增私有方法（放在 `listFor` 之前）：

```ts
/**
 * 列表/详情共享的合并视图（含 disabled 安装行，同名安装遮蔽内置）。
 * listFor 在此之上剥离 files；detailFor 保留 files。
 */
private async mergedMapFor(userId: string): Promise<Map<string, SkillDef>> {
  const builtins = scanSkillDir(builtinDir(), 'builtin', true);
  const map = new Map<string, SkillDef>(builtins.map((s) => [s.name, s]));
  const installed = await this.buildInstalledMap(userId, true);
  for (const [name, def] of installed) {
    map.set(name, def);
  }
  return map;
}
```

b) 重写 `listFor` 复用它（外部行为不变，现有测试必须全绿）：

```ts
async listFor(userId: string): Promise<Omit<SkillDef, 'files'>[]> {
  const map = await this.mergedMapFor(userId);
  return [...map.values()].map(({ files: _f, ...rest }) => rest);
}
```

c) 新增 `detailFor`（放在 `getFor` 之后）：

```ts
/** 技能详情（管理页用，listFor 同语义：含 disabled）。files 只回路径列表，SKILL.md 单独回原文。 */
async detailFor(
  userId: string,
  name: string,
): Promise<(Omit<SkillDef, 'files'> & { files: string[]; skillMd: string }) | undefined> {
  const def = (await this.mergedMapFor(userId)).get(name);
  if (!def) return undefined;
  const { files, ...rest } = def;
  return { ...rest, files: Object.keys(files).sort(), skillMd: files['SKILL.md'] ?? '' };
}
```

- [ ] **Step 1.4: 跑测试确认通过（含既有用例无回归）**

Run: `cd apps/backend && npx jest src/skills/skills.service.spec.ts`
Expected: PASS，全部用例绿（既有 effectiveSkillsFor/listFor/getFor 用例 + 新增 4 条）

- [ ] **Step 1.5: Checkpoint（不 commit）**

确认 `git status` 只动了 `skills.service.ts` 与 `skills.service.spec.ts`。

### Task 2: GET /skills/:name 控制器路由

**Files:**
- Modify: `apps/backend/src/skills/skills.controller.ts`（在 `list()` 之后插入 `detail()`）

- [ ] **Step 2.1: 实现路由**

在 `skills.controller.ts` 的 `list()`（约 :56）与 `install()` 之间插入：

```ts
/** 技能详情（含文件路径列表与 SKILL.md 原文）。listFor 同语义：disabled 也可查看。 */
@Get(':name')
async detail(@Param('name') name: string, @CurrentUser() user: AuthUser) {
  const def = await this.skills.detailFor(user.userId, name);
  if (!def) {
    throw new BusinessException(ErrorCodes.SKILL_NOT_FOUND, HttpStatus.NOT_FOUND);
  }
  return def;
}
```

注意：`@Get(':name')` 只匹配 GET，不会劫持 `POST /skills/install`；所需 import（`Get`/`Param`/`BusinessException`/`ErrorCodes`/`HttpStatus`）该文件均已存在（`skills.controller.ts:19-38`）。

- [ ] **Step 2.2: 类型检查**

Run: `cd apps/backend && npx tsc --noEmit`
Expected: 无输出（exit 0）

- [ ] **Step 2.3: Checkpoint（不 commit）**

### Task 2b: 回归测试——更新失败不破坏已安装的旧 skill

spec 要求（§2 更新失败语义）：重装失败时磁盘旧 skill 必须完好。installer 在 tmp 完成解压与校验后才动 dest（`skill-installer.ts`），用测试钉住该行为。

**Files:**
- Test: `apps/backend/src/skills/skill-installer.spec.ts`

- [ ] **Step 2b.1: 写测试**

在 `describe('extractSkillFromTarball')` 内追加（复用文件内已有的 `buildFixtureTarball` / `destRoot`）：

```ts
// ─── 更新失败语义：dest 已有旧版，重装来源失效 → 抛错且旧文件完好 ─────────────
it('更新失败（新 tarball 不含目标路径）→ 抛错且已安装旧版完好', async () => {
  // 先正常安装旧版
  const oldMd = `---\nname: docx\ndescription: 旧版\n---\nold body`;
  const okTarball = await buildFixtureTarball({
    repoPrefix: 'skills-main',
    skillPath: 'document-skills/docx',
    skillMdContent: oldMd,
  });
  await extractSkillFromTarball({
    tarball: okTarball,
    repoPrefix: 'skills-main',
    path: 'document-skills/docx',
    destRoot,
    source: 'github:a/b#document-skills/docx@main',
  });

  // 模拟上游路径被删：新 tarball 里只有别的目录，目标路径下无 SKILL.md
  const brokenTarball = await buildFixtureTarball({
    repoPrefix: 'skills-main',
    skillPath: 'document-skills/other',
    skillMdContent: `---\nname: other\ndescription: x\n---\nbody`,
  });
  await expect(
    extractSkillFromTarball({
      tarball: brokenTarball,
      repoPrefix: 'skills-main',
      path: 'document-skills/docx',
      destRoot,
      source: 'github:a/b#document-skills/docx@main',
    }),
  ).rejects.toThrow(BusinessException);

  // 旧版完好：失败发生在 tmp 阶段，dest 未被触碰
  expect(readFileSync(join(destRoot, 'docx', 'SKILL.md'), 'utf8')).toBe(oldMd);
});
```

- [ ] **Step 2b.2: 跑测试**

Run: `cd apps/backend && npx jest src/skills/skill-installer.spec.ts`
Expected: PASS（若该用例失败 = installer 在校验前就动了 dest，按 spec"已知边界"提示对 installer 做最小调整：把 `rmSync(finalDest)` 移到 tmp 校验全部通过之后，再重跑）

- [ ] **Step 2b.3: Checkpoint（不 commit）**

### Task 3: PasskeyService 重构——抽出登录态可复用的 user 维度方法

现有 `registrationOptions(email)` / `verifyRegistration(email,...)` 都从客户端 email 出发（`passkey.service.ts:42-43, 75-81`），登录态添加 passkey 不能走它们。抽出以 user 为入参的核心方法，email 版包装之，**外部行为不变**。

**Files:**
- Modify: `apps/backend/src/auth/passkey.service.ts`
- Modify: `apps/backend/src/auth/auth.module.ts`（exports 加 `PasskeyService`）

- [ ] **Step 3.1: 重构 registrationOptions**

```ts
/** 注册第一步：按 email 找/建用户，产出注册 options，挑战存 Redis。 */
async registrationOptions(email: string, rpId?: string) {
  const user = await this.auth.findOrCreateByEmail(email);
  return this.registrationOptionsForUser(user, rpId);
}

/** 同上，但用户已知（登录态添加 passkey 用）：userId 来自 JWT，不信任客户端 email。 */
async registrationOptionsForUser(
  user: { id: string; email: string },
  rpId?: string,
) {
  // ……原 registrationOptions 中 findOrCreateByEmail 之后的全部代码原样移入，
  // 其中 userName: email 改为 userName: user.email，user.id 引用不变……
}
```

- [ ] **Step 3.2: 重构 verifyRegistration**

```ts
/** 注册第二步：校验响应，存 Authenticator。注册成功即登录：签发 JWT。 */
async verifyRegistration(
  email: string,
  response: RegistrationResponseJSON,
  rpId?: string,
  origin?: string,
) {
  const user = await this.auth.findOrCreateByEmail(email);
  await this.verifyRegistrationForUser(user.id, response, rpId, origin);
  const token = await this.auth.signToken(user);
  return { verified: true, token, email: user.email };
}

/**
 * 校验注册响应并落库（登录态添加 passkey 用）：不签发 token，
 * 返回新建凭据行（id/createdAt/transports），供管理页直接插入列表。
 */
async verifyRegistrationForUser(
  userId: string,
  response: RegistrationResponseJSON,
  rpId?: string,
  origin?: string,
) {
  // ⚠️ 移动边界（防重复落库）：只把"挑战取出 + verifyRegistrationResponse 校验"
  // 段（passkey.service.ts:82-102，从 redis.get 到两个 PASSKEY_VERIFY_FAILED 抛错）
  // 原样移入，`user.id` 替换为 userId；
  // 原 :103-112 的 authenticator.create + redis.del 不要照搬——用下面这个
  // 捕获返回行的版本【替换】它们（整个方法里 create 只出现这一次）：
  const row = await this.prisma.authenticator.create({
    data: {
      credentialId: info.credential.id,
      userId,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: (response.response.transports ?? []).join(',') || null,
    },
  });
  await this.redis.del(`webauthn:reg:${userId}`);
  return { id: row.id, createdAt: row.createdAt, transports: row.transports };
}
```

注意：Redis challenge key 是 `webauthn:reg:${userId}`，两个变体天然共用。

- [ ] **Step 3.3: AuthModule 导出 PasskeyService**

`auth.module.ts` 的 `exports` 数组改为 `[JwtAuthGuard, JwtModule, PasskeyService]`（AuthModule 是 `@Global()`，导出后 Task 4 的 UsersController 可直接注入 PasskeyService，无需在 UsersModule imports 里声明）。

- [ ] **Step 3.4: 类型检查 + 既有测试无回归**

Run: `cd apps/backend && npx tsc --noEmit && npx jest`
Expected: tsc 无输出；jest 全绿（passkey 无既有 spec，靠全量回归兜底）

- [ ] **Step 3.5: Checkpoint（不 commit）**

### Task 4: Users 模块（GET /users/me + passkey 管理）

**Files:**
- Create: `apps/backend/src/users/users.module.ts`
- Create: `apps/backend/src/users/users.controller.ts`
- Create: `apps/backend/src/users/users.service.ts`
- Create: `apps/backend/src/users/dto/my-passkey.dto.ts`
- Test: `apps/backend/src/users/users.service.spec.ts`
- Modify: `apps/backend/src/app.module.ts`（imports 加 `UsersModule`）

- [ ] **Step 4.1: 写失败测试**

`users.service.spec.ts`：

```ts
import { UsersService } from './users.service';

const prismaMock = {
  user: { findUnique: jest.fn() },
  authenticator: { findFirst: jest.fn(), delete: jest.fn() },
};

beforeEach(() => jest.clearAllMocks());

describe('UsersService.getMe', () => {
  it('返回 email/createdAt/tenantName/passkeys（transports 可为 null）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      createdAt: new Date('2026-01-01'),
      tenant: { name: 'a@b.c' },
      authenticators: [
        { id: 'pk1', createdAt: new Date('2026-02-02'), transports: 'internal,hybrid' },
        { id: 'pk2', createdAt: new Date('2026-03-03'), transports: null },
      ],
    });
    const svc = new UsersService(prismaMock as never);
    const me = await svc.getMe('u1');
    expect(me.email).toBe('a@b.c');
    expect(me.tenantName).toBe('a@b.c');
    expect(me.passkeys).toEqual([
      { id: 'pk1', createdAt: new Date('2026-02-02'), transports: 'internal,hybrid' },
      { id: 'pk2', createdAt: new Date('2026-03-03'), transports: null },
    ]);
    // 不泄漏 publicKey/counter/credentialId 等内部列
    expect(Object.keys(me.passkeys[0]).sort()).toEqual(['createdAt', 'id', 'transports']);
  });
});

describe('UsersService.deletePasskey', () => {
  it('删除本人 passkey', async () => {
    prismaMock.authenticator.findFirst.mockResolvedValue({ id: 'pk1' });
    prismaMock.authenticator.delete.mockResolvedValue({});
    const svc = new UsersService(prismaMock as never);
    await expect(svc.deletePasskey('u1', 'pk1')).resolves.toEqual({ deleted: 'pk1' });
    expect(prismaMock.authenticator.findFirst).toHaveBeenCalledWith({
      where: { id: 'pk1', userId: 'u1' },
    });
  });

  it('他人/不存在的 passkey 抛 PASSKEY_NOT_FOUND', async () => {
    prismaMock.authenticator.findFirst.mockResolvedValue(null);
    const svc = new UsersService(prismaMock as never);
    // BusinessException 暴露 readonly errCode（business.exception.ts:9），30003 = PASSKEY_NOT_FOUND
    await expect(svc.deletePasskey('u1', 'other')).rejects.toMatchObject({
      errCode: 30003,
    });
  });
});
```

- [ ] **Step 4.2: 跑测试确认失败**

Run: `cd apps/backend && npx jest src/users`
Expected: FAIL（模块不存在）

- [ ] **Step 4.3: 实现 UsersService**

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';

/** 当前用户只读信息 + passkey 管理。所有方法以 JWT 的 userId 为唯一身份来源。 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true, authenticators: true },
    });
    if (!user) {
      throw new BusinessException(ErrorCodes.INTERNAL_ERROR, HttpStatus.NOT_FOUND);
    }
    return {
      email: user.email,
      createdAt: user.createdAt,
      tenantName: user.tenant.name,
      // 只回展示所需字段，不泄漏 publicKey/counter/credentialId
      passkeys: user.authenticators.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        transports: a.transports,
      })),
    };
  }

  /** 删除本人 passkey。按 (id, userId) 查行防越权；允许删到 0（邮箱登录兜底）。 */
  async deletePasskey(userId: string, id: string) {
    const row = await this.prisma.authenticator.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new BusinessException(ErrorCodes.PASSKEY_NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    await this.prisma.authenticator.delete({ where: { id: row.id } });
    return { deleted: row.id };
  }
}
```

- [ ] **Step 4.4: 实现 DTO**

`dto/my-passkey.dto.ts`（沿用 `auth/dto/passkey.dto.ts` 的 `PasskeyRpDto` 模式，但不含 email——身份只来自 JWT）：

```ts
import { IsObject } from 'class-validator';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { PasskeyRpDto } from '../../auth/dto/passkey.dto';

/** 登录态添加 passkey 第一步入参：仅 rpId/origin（继承），身份取自 JWT。 */
export class MyPasskeyOptionsDto extends PasskeyRpDto {}

/** 登录态添加 passkey 第二步入参：WebAuthn 注册响应。 */
export class MyPasskeyVerifyDto extends PasskeyRpDto {
  @IsObject()
  response!: RegistrationResponseJSON;
}
```

- [ ] **Step 4.5: 实现 Controller + Module，注册到 AppModule**

`users.controller.ts`：

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PasskeyService } from '../auth/passkey.service';
import { MyPasskeyOptionsDto, MyPasskeyVerifyDto } from './dto/my-passkey.dto';
import { UsersService } from './users.service';

/**
 * UsersController — 当前用户信息与 passkey 管理（全部登录态）。
 * 安全：身份一律取自 JWT（@CurrentUser），不接受客户端传 email/userId，
 * 避免登录用户把 passkey 挂到他人账户（公开注册接口走 auth/passkey.controller.ts）。
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly passkey: PasskeyService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.getMe(user.userId);
  }

  @Post('me/passkeys/options')
  passkeyOptions(@Body() dto: MyPasskeyOptionsDto, @CurrentUser() user: AuthUser) {
    return this.passkey.registrationOptionsForUser(
      { id: user.userId, email: user.email },
      dto.rpId,
    );
  }

  @Post('me/passkeys/verify')
  passkeyVerify(@Body() dto: MyPasskeyVerifyDto, @CurrentUser() user: AuthUser) {
    return this.passkey.verifyRegistrationForUser(
      user.userId,
      dto.response,
      dto.rpId,
      dto.origin,
    );
  }

  @Delete('me/passkeys/:id')
  deletePasskey(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.users.deletePasskey(user.userId, id);
  }
}
```

`users.module.ts`（不需要 @Global，无人注入它）：

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** 无 imports 数组是有意的：PrismaModule 与 AuthModule 均为 @Global()，
 *  PrismaService / PasskeyService 不需要在此声明即可注入。 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

`app.module.ts`：`imports` 数组末尾（`SandboxModule` 之后）追加 `UsersModule`，顶部按现有就近风格加 import 语句。

- [ ] **Step 4.6: 跑测试确认通过 + 全量回归**

Run: `cd apps/backend && npx jest src/users && npx tsc --noEmit && npx jest`
Expected: 新用例 PASS；tsc 无输出；全量 jest 绿

- [ ] **Step 4.7: Checkpoint（不 commit）**

后端完成。`git status` 应只包含：skills.service(.spec).ts、skills.controller.ts、passkey.service.ts、auth.module.ts、users/ 新目录、app.module.ts。

---

## Chunk 2: Frontend

### Task 5: api.ts 新增类型与函数

**Files:**
- Modify: `apps/frontend/src/lib/api.ts`

- [ ] **Step 5.1: Skills 详情 + 用户信息 API**

在 `// ——— Skills 技能管理 ———` 段末尾（`deleteSkill` 之后）追加：

```ts
/** 技能详情（GET /skills/:name）：文件路径列表 + SKILL.md 原文。 */
export interface SkillDetail extends SkillInfo {
  files: string[];
  skillMd: string;
}

export function getSkillDetail(name: string): Promise<SkillDetail> {
  return request(`/skills/${encodeURIComponent(name)}`);
}

/** 解析 install 落库的 source 串（github:owner/repo#path@ref），供"更新"按钮重装同源。 */
export function parseGithubSource(source: string): InstallSkillInput | null {
  const m = /^github:([^#]+)#([^@]+)@(.+)$/.exec(source);
  if (!m) return null;
  return { repo: m[1], path: m[2], ref: m[3] };
}
```

在文件末尾（passkey 段之后）追加：

```ts
// ——— 当前用户（/users/me）———

/** 已注册 passkey（transports 为逗号拼接串，可为 null，前端自行 split）。 */
export interface MyPasskey {
  id: string;
  createdAt: string;
  transports: string | null;
}

export interface MeInfo {
  email: string;
  createdAt: string;
  tenantName: string;
  passkeys: MyPasskey[];
}

export function getMe(): Promise<MeInfo> {
  return request("/users/me");
}

/** 登录态添加 passkey：身份取自 JWT，只传 rpId/origin。 */
export function myPasskeyOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return request("/users/me/passkeys/options", {
    method: "POST",
    body: JSON.stringify(rp()),
  });
}

export function myPasskeyVerify(
  response: RegistrationResponseJSON,
): Promise<MyPasskey> {
  return request("/users/me/passkeys/verify", {
    method: "POST",
    body: JSON.stringify({ response, ...rp() }),
  });
}

export function deleteMyPasskey(id: string): Promise<{ deleted: string }> {
  return request(`/users/me/passkeys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
```

注意：`rp()`、`PublicKeyCredentialCreationOptionsJSON`、`RegistrationResponseJSON` 已在该文件 passkey 段定义/导入（`api.ts:248-258`）。

- [ ] **Step 5.2: 类型检查**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 5.3: Checkpoint（不 commit）**

### Task 6: Settings 外壳 + 入口 + 旧路由迁移

**Files:**
- Create: `apps/frontend/src/app/settings/layout.tsx`
- Create: `apps/frontend/src/app/settings/_components/settings-nav.tsx`
- Create: `apps/frontend/src/app/settings/page.tsx`
- Modify: `apps/frontend/src/app/skills/page.tsx`（整文件替换为 redirect）
- Modify: `apps/frontend/src/app/agent/_components/conversation-sidebar.tsx`（底部加齿轮入口）
- Move: `apps/frontend/src/app/skills/_components/*` → `apps/frontend/src/app/settings/skills/_components/*`（Task 7 一并处理）

- [ ] **Step 6.1: settings-nav.tsx（client，usePathname 高亮）**

```tsx
"use client";

import { CircleUserRound, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/settings/skills", label: "Skills", icon: Wrench },
  { href: "/settings/profile", label: "Profile", icon: CircleUserRound },
] as const;

/** Settings 左侧分区导航（desktop 纵向）/ 顶部横向（mobile）。 */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 6.2: layout.tsx（server component，外壳 + 返回按钮）**

```tsx
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { SettingsNav } from "./_components/settings-nav";

// /settings 外壳：返回 agent + 标题 + 左侧分区导航（mobile 折叠为顶部横向）。
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6 font-sans sm:p-8">
      <header className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/agent" />}
          className="-ml-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> Back to conversations
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      </header>
      <div className="flex flex-col gap-6 sm:flex-row">
        <aside className="shrink-0 sm:w-44">
          <SettingsNav />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </main>
  );
}
```

注意：`Button` 的 `nativeButton={false} render={<Link …/>}` 是项目既有 base-ui 模式（`app/skills/page.tsx:17-24`）。若 layout 中 server/client 组合报错，先查 next 文档再调整。

- [ ] **Step 6.3: /settings 与旧 /skills 的 redirect**

`settings/page.tsx`：

```tsx
import { redirect } from "next/navigation";

// /settings 默认进 Skills 分区
export default function SettingsPage() {
  redirect("/settings/skills");
}
```

旧 `skills/page.tsx` 整文件替换为：

```tsx
import { redirect } from "next/navigation";

// 旧路由迁移：技能管理已并入 /settings/skills
export default function SkillsPage() {
  redirect("/settings/skills");
}
```

- [ ] **Step 6.4: 侧栏齿轮入口**

`conversation-sidebar.tsx` 底部用户区（`ThemeToggle` 与 Sign out 之间，约 :157-173）插入：

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        nativeButton={false}
        render={<Link href="/settings" />}
      />
    }
  >
    <Settings />
  </TooltipTrigger>
  <TooltipContent>Settings</TooltipContent>
</Tooltip>
```

顶部 import 增加 `Settings`（lucide-react，加进现有 import）与 `import Link from "next/link";`。

- [ ] **Step 6.5: 类型检查 + lint**

Run: `cd apps/frontend && npx tsc --noEmit && pnpm lint`
Expected: 均无错误（settings/skills/page.tsx 此时尚未创建，`/settings/skills` 404 属预期，Task 7 解决）

- [ ] **Step 6.6: Checkpoint（不 commit）**

### Task 7: Skills 模块（迁移 + 搜索/筛选/分组 + 更新 + 详情）

**Files:**
- Create: `apps/frontend/src/app/settings/skills/page.tsx`
- Move+Modify: `app/skills/_components/install-form.tsx` → `app/settings/skills/_components/install-form.tsx`（仅移动，内容不变）
- Move+Modify: `app/skills/_components/skill-list.tsx` → `app/settings/skills/_components/skill-list.tsx`（扩展）
- Create: `apps/frontend/src/app/settings/skills/_components/skill-detail-sheet.tsx`
- Delete: `apps/frontend/src/app/skills/_components/`（迁移后删除整个目录）

- [ ] **Step 7.1: 迁移 _components**

`git mv apps/frontend/src/app/skills/_components apps/frontend/src/app/settings/skills/_components`（保留 git 历史；这是文件移动不是 commit）。

- [ ] **Step 7.2: page.tsx（搜索 + 筛选状态收口在页面层）**

```tsx
"use client";

import { Search } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { InstallForm } from "./_components/install-form";
import { SkillList, type SourceFilter } from "./_components/skill-list";

// /settings/skills：技能管理——搜索 / 来源筛选 / domain 分组 / 安装 / 启停 / 更新 / 删除 / 详情。
export default function SkillsSettingsPage() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Skills</h2>
        <p className="text-sm text-muted-foreground">
          Manage the skills available to the agent: built-in skills ship with
          the system, and you can install third-party skills from GitHub.
        </p>
      </header>

      <InstallForm />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills…"
            className="h-9 pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Tabs value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
            <TabsTrigger value="github">GitHub</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <SkillList search={search} source={source} />
    </div>
  );
}
```

注意：先确认项目 `tabs.tsx` 的受控 API（base-ui 包装，`value/onValueChange` 命名可能不同），以组件源码为准。

- [ ] **Step 7.3: skill-list.tsx 扩展（筛选 + 分组 + 更新 + 详情入口）**

在迁移后的 `skill-list.tsx` 上修改：

a) 导出筛选类型并接收 props：

```tsx
export type SourceFilter = "all" | "builtin" | "github";

export function SkillList({ search, source }: { search: string; source: SourceFilter }) {
  const [detailName, setDetailName] = useState<string | null>(null);
  // …query 不变…
```

b) 过滤 + 分组（替换原 `skills.map` 直渲染）：

```tsx
const q = search.trim().toLowerCase();
const filtered = skills.filter((s) => {
  if (source === "builtin" && s.source !== "builtin") return false;
  if (source === "github" && s.source === "builtin") return false;
  if (!q) return true;
  return (
    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  );
});

const groups = new Map<string, SkillInfo[]>();
for (const s of filtered) {
  const list = groups.get(s.domain) ?? [];
  list.push(s);
  groups.set(s.domain, list);
}
const domains = [...groups.keys()].sort();
```

渲染：空结果（filtered.length === 0 且 skills.length > 0）显示 "No skills match your filters."；否则按 domain 分组：

```tsx
<div className="space-y-6">
  {domains.map((domain) => (
    <section key={domain} className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {domain}
      </h3>
      <div className="space-y-3">
        {groups.get(domain)!.map((skill) => (
          <SkillCard
            key={skill.name}
            skill={skill}
            onOpenDetail={() => setDetailName(skill.name)}
          />
        ))}
      </div>
    </section>
  ))}
  <SkillDetailSheet
    name={detailName}
    onClose={() => setDetailName(null)}
  />
</div>
```

c) SkillCard 扩展（签名改为）：

```tsx
function SkillCard({
  skill,
  onOpenDetail,
}: {
  skill: SkillInfo;
  onOpenDetail: () => void;
}) {
```

- 整卡可点开详情：`<Card>` 加 `onClick={onOpenDetail}` 与 `cursor-pointer transition-colors hover:bg-accent/40`；右侧控件容器加 `onClick={(e) => e.stopPropagation()}`（启停/删除/更新不触发详情）。
- 卡片描述下方加 disabled 态视觉：`!skill.enabled && "opacity-60"` 应用到内容区。
- GitHub 技能加更新按钮（在 Switch 左侧）：

```tsx
const updateMut = useMutation({
  mutationFn: () => {
    const src = parseGithubSource(skill.source);
    if (!src) throw new Error("Unrecognized source format");
    return installSkill(src);
  },
  onSuccess: () => qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
});
```

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Update skill"
        disabled={updateMut.isPending}
        onClick={() => updateMut.mutate()}
      />
    }
  >
    {updateMut.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
  </TooltipTrigger>
  <TooltipContent>Reinstall from source</TooltipContent>
</Tooltip>
```

错误展示并入现有 `toggleMut.isError || deleteMut.isError` 行（加 `|| updateMut.isError`）。
imports 增加：`RefreshCw`、`Tooltip` 三件套、`installSkill`、`parseGithubSource`、`SkillDetailSheet`。

- [ ] **Step 7.4: skill-detail-sheet.tsx**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getSkillDetail } from "@/lib/api";

import { Markdown } from "@/app/agent/_components/markdown";

/** 技能详情侧拉：SKILL.md 渲染 + 文件清单 + 元信息。name 为 null 时关闭。 */
export function SkillDetailSheet({
  name,
  onClose,
}: {
  name: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["skill-detail", name],
    queryFn: () => getSkillDetail(name!),
    enabled: name !== null,
  });
  const d = query.data;

  return (
    <Sheet open={name !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 宽度类必须带 data-[side=right] 修饰符：组件默认宽度是变体前缀类
          （sheet.tsx:56 的 data-[side=right]:w-3/4 等），裸 w-full/sm:max-w-xl
          会被更高特异性的默认值压住而成为 no-op */}
      <SheetContent
        side="right"
        className="flex flex-col data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="truncate">{name}</span>
            {d && (
              <>
                <Badge variant={d.source === "builtin" ? "secondary" : "outline"}>
                  {d.source === "builtin" ? "Built-in" : "GitHub"}
                </Badge>
                <Badge variant="outline">{d.domain}</Badge>
                {!d.enabled && <Badge variant="destructive">Disabled</Badge>}
              </>
            )}
          </SheetTitle>
          {d && (
            <SheetDescription className="truncate text-left">
              {d.source === "builtin" ? "Ships with the system" : d.source}
            </SheetDescription>
          )}
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-4">
          {query.isLoading && (
            <div className="space-y-3 py-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          )}
          {query.isError && (
            <p className="py-4 text-sm text-destructive" role="alert">
              {query.error instanceof Error ? query.error.message : "Failed to load"}
            </p>
          )}
          {d && (
            <div className="space-y-4 pb-6">
              <Markdown>{d.skillMd}</Markdown>
              <Separator />
              <section className="space-y-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Files ({d.files.length})
                </h3>
                <ul className="space-y-1">
                  {d.files.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 font-mono text-xs text-foreground/80"
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
```

注意：先确认项目 `sheet.tsx` 的实际 API（`side` prop、是否内置 ScrollArea/padding），以组件源码与 `agent` 模块既有 Sheet 用法为准调整。`Markdown` 从 `agent/_components` 跨目录导入是有意的轻量复用（不搬家——遵循 surgical changes）。

- [ ] **Step 7.5: 类型检查 + lint**

Run: `cd apps/frontend && npx tsc --noEmit && pnpm lint`
Expected: 均无错误；确认 `app/skills/` 下只剩 redirect 的 page.tsx

- [ ] **Step 7.6: Checkpoint（不 commit）**

### Task 8: Profile 模块

**Files:**
- Create: `apps/frontend/src/app/settings/profile/page.tsx`
- Create: `apps/frontend/src/app/settings/profile/_components/account-card.tsx`
- Create: `apps/frontend/src/app/settings/profile/_components/passkeys-card.tsx`

- [ ] **Step 8.1: page.tsx**

```tsx
"use client";

import { AccountCard } from "./_components/account-card";
import { PasskeysCard } from "./_components/passkeys-card";

// /settings/profile：账户只读信息 + passkey 管理。
export default function ProfileSettingsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Your account information and sign-in methods.
        </p>
      </header>
      <AccountCard />
      <PasskeysCard />
    </div>
  );
}
```

- [ ] **Step 8.2: account-card.tsx**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getMe } from "@/lib/api";

export const ME_QUERY_KEY = ["me"] as const;

/** 账户只读信息：email / 租户 / 注册时间。 */
export function AccountCard() {
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: getMe });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {query.error instanceof Error ? query.error.message : "Failed to load"}
          </p>
        ) : query.data ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="truncate font-medium">{query.data.email}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="truncate font-medium">{query.data.tenantName}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Member since</dt>
              <dd className="font-medium">
                {new Date(query.data.createdAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 8.3: passkeys-card.tsx**

```tsx
"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
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

/** Passkey 管理：列表 / 添加（WebAuthn 注册）/ 删除（两步确认）。 */
export function PasskeysCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: getMe });

  const addMut = useMutation({
    mutationFn: async () => {
      const options = await myPasskeyOptions();
      // 用户在系统弹窗取消时 startRegistration 抛 NotAllowedError，
      // 由 mutation 错误态接住，与其他失败一致展示
      const response = await startRegistration({ optionsJSON: options });
      return myPasskeyVerify(response);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });

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
          disabled={addMut.isPending}
          onClick={() => addMut.mutate()}
        >
          {addMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add passkey
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {addMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {addMut.error instanceof Error
              ? addMut.error.message
              : "Failed to add passkey"}
          </p>
        )}
        {query.isLoading ? (
          <Skeleton className="h-14 w-full rounded-lg" />
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

function PasskeyRow({ passkey }: { passkey: MyPasskey }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const deleteMut = useMutation({
    mutationFn: () => deleteMyPasskey(passkey.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });
  const transports = passkey.transports?.split(",").filter(Boolean) ?? [];

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            Added {new Date(passkey.createdAt).toLocaleDateString()}
          </p>
          <div className="flex flex-wrap gap-1">
            {transports.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">
                {t}
              </Badge>
            ))}
          </div>
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

- [ ] **Step 8.4: 类型检查 + lint**

Run: `cd apps/frontend && npx tsc --noEmit && pnpm lint`
Expected: 均无错误

- [ ] **Step 8.5: Checkpoint（不 commit）**

---

## Chunk 3: 端到端验证

### Task 9: 全量验证（preview 实测）

- [ ] **Step 9.1: 后端全量**

Run: `cd apps/backend && npx tsc --noEmit && npx jest`
Expected: 全绿

- [ ] **Step 9.2: 前端静态检查**

Run: `cd apps/frontend && npx tsc --noEmit && pnpm lint`
Expected: 无错误

- [ ] **Step 9.3: preview 实测（按 preview_* 工具流程）**

前置：后端（3101）需在跑；登录态可用邮箱登录。逐项验证并截图：

1. `/agent` 侧栏底部出现齿轮 → 点击进入 `/settings/skills`；旧 `/skills` 访问被 redirect。
2. Skills：列表按 domain 分组；搜索过滤生效；Built-in/GitHub 筛选生效；点卡片打开详情 Sheet（SKILL.md 渲染 + 文件清单）；GitHub 技能可见更新按钮（如环境无 GitHub 技能，先用 InstallForm 装一个，如 `anthropics/skills` + `document-skills/docx`）；更新按钮转圈后列表刷新；启停/删除回归正常。
3. Profile：`/settings/profile` 显示 email/workspace/member since；passkeys 列表正确（transports 徽章；无 passkey 时空态文案）；删除走两步确认并刷新。"Add passkey" 在无 WebAuthn 设备的环境下点到系统弹窗出现即可（取消后错误态内联展示，不崩页）。
4. 暗色模式切换后重看 settings 两页（无硬编码色穿帮）。
5. mobile 视口（preview_resize）确认 settings 导航横向折叠可用；**测完恢复 desktop 视口**。
6. 网络面板确认 `GET /skills/:name`、`GET /users/me`、`DELETE /users/me/passkeys/:id` 返回 `{code:0}` 信封。

- [ ] **Step 9.4: 汇总 Verification 报告（CLAUDE.md 格式），停下等用户审查与提交指令**
