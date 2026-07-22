# Skills 模块重构实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 skills 实现重构为 Claude Code 同等效果：StoreBackend 持久技能 + Daytona 沙箱执行脚本 + GitHub 安装开源技能 + 用户级启停 API + 最小前端页。

**Architecture:** 官方 deepagents 模式 `CompositeBackend(sandbox, { "/skills/": StoreBackend })`，worker 每 run 前把 `effectiveSkillsFor(userId)` diff 播种进 InMemoryStore（namespace `[userId, "skills"]`），`beforeAgent` 中间件把技能文件 `uploadFiles` 进沙箱供 `execute` 跑脚本。无 `DAYTONA_API_KEY` 回退 StateBackend。

**Tech Stack:** NestJS 11 / Prisma(MySQL) / BullMQ / deepagents@1.10.2 / @langchain/daytona@0.2.0 / @langchain/langgraph InMemoryStore / Next.js + shadcn/ui

**设计文档：** `docs/superpowers/specs/2026-06-10-skills-module-refactor-design.md`（已评审批准，本计划与其条款一一对应）

---

## 全局约定（每个任务都适用）

- **禁止自行 git commit/push**（项目 CLAUDE.md 规则 0 覆盖本 skill 的"频繁提交"惯例）。每个任务以"验证通过"为完成态，提交由用户决定。
- **所有 node/jest 命令前置 node 22**：`export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`（默认 shell 是 node 14，jest 会静默假绿）。
- 后端工作目录：`/Users/biu/Desktop/agent-test/apps/backend`；前端：`/Users/biu/Desktop/agent-test/apps/frontend`。
- 类型检查命令：`npx tsc --noEmit -p tsconfig.json`；测试：`npx jest <path>`。
- **已核实的关键包行为（实现时以此为准，不要按官方文档臆写）**：
  - `StoreBackend` namespace 工厂签名是 `({ state, config, assistantId }) => string[]`（dist 已核实），**runtime context 拿不到**——userId 必须放 `config.configurable.userId`。
  - `store.put(namespace, key, value)` 的 key 用完整虚拟路径 `/skills/<name>/<rel>`，value 形如 `{ content: string[], created_at, modified_at }`（`convertStoreItemToFileData` 校验这三字段）。
  - `DaytonaSandbox`（@langchain/daytona@0.2.0）：静态 `create(options)` / `fromId(id, options)`；实例 `start(timeout?)` / `isRunning` / `uploadFiles(Array<[string, Uint8Array]>)` / `downloadFiles(paths)` / `execute(cmd)`；options 含 `labels / autoStopInterval / autoDeleteInterval / envVars`。
  - `CompositeBackend.uploadFiles/downloadFiles` 存在（委托默认后端）。

---

## Chunk 1: skills 模块核心（数据层 + 注册表 + 安装器 + API）

### Task 1: Prisma Skill 模型

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`

- [ ] **Step 1.1: 追加模型**

```prisma
/** 用户安装的技能（内置技能不入库）。落盘目录 SKILLS_DATA_DIR/<userId>/<name>/。 */
model Skill {
  id          String   @id @default(cuid())
  name        String
  description String   @db.Text
  source      String // 如 "github:anthropics/skills#document-skills/docx@main"
  userId      String // 非空：MySQL 可空唯一键允许重复 NULL，不留可空层（见设计文档 §2）
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
}
```

- [ ] **Step 1.2: 迁移并生成 client**

Run: `cd apps/backend && npx prisma migrate dev --name add_skill`
Expected: 新迁移目录生成、`prisma generate` 成功。（需要 docker-compose.dev.yml 的 MySQL 在跑；不在则先 `docker compose -f ../../docker-compose.dev.yml up -d`）

- [ ] **Step 1.3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors

### Task 2: skill-parser（frontmatter 解析 + agentskills.io 规范校验）

现状 `parseSkill` 在 `command-registry.service.ts:45`，无校验。迁出并补校验。

**Files:**
- Create: `apps/backend/src/skills/skill-parser.ts`
- Test: `apps/backend/src/skills/skill-parser.spec.ts`

- [ ] **Step 2.1: 写失败测试**

```typescript
import { parseSkillMd, validateSkill } from './skill-parser';

describe('parseSkillMd', () => {
  it('解析 frontmatter name/description 与正文', () => {
    const raw = `---\nname: docx\ndescription: Word 文档处理\n---\n# 正文`;
    expect(parseSkillMd(raw, 'docx')).toEqual({
      name: 'docx',
      description: 'Word 文档处理',
      body: '# 正文',
    });
  });
  it('无 frontmatter 时回退目录名', () => {
    expect(parseSkillMd('正文', 'fallback').name).toBe('fallback');
  });
});

describe('validateSkill', () => {
  const ok = { name: 'docx', description: 'x', dirName: 'docx' };
  it('合法技能通过', () => expect(validateSkill(ok)).toEqual([]));
  it('name 必须小写字母数字连字符且 ≤64', () => {
    expect(validateSkill({ ...ok, name: 'Bad_Name' })).not.toEqual([]);
    expect(validateSkill({ ...ok, name: 'a'.repeat(65) })).not.toEqual([]);
  });
  it('name 必须与目录名一致', () => {
    expect(validateSkill({ ...ok, dirName: 'other' })).not.toEqual([]);
  });
  it('description 必填且 ≤1024', () => {
    expect(validateSkill({ ...ok, description: '' })).not.toEqual([]);
    expect(validateSkill({ ...ok, description: 'a'.repeat(1025) })).not.toEqual([]);
  });
  it('可选 compatibility ≤500', () => {
    expect(validateSkill({ ...ok, compatibility: 'a'.repeat(501) })).not.toEqual([]);
    expect(validateSkill({ ...ok, compatibility: 'needs internet' })).toEqual([]);
  });
});
```

（`parseSkillMd` 同时透传可选 frontmatter 字段 `license`/`compatibility`/`allowed-tools` 进 `ParsedSkill`（可选属性），`metadata.entrypoint` 本期不消费、不解析——设计 §1 范围内的裁剪，规范校验只额外管 `compatibility` 长度。）

- [ ] **Step 2.2: 跑测试确认失败**

Run: `npx jest src/skills/skill-parser.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2.3: 实现**

```typescript
/** SKILL.md 解析与 agentskills.io 规范校验（纯函数，不依赖 fs）。 */

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/** 取 frontmatter 的 name/description + 正文（沿用 command-registry 原逻辑迁出）。 */
export function parseSkillMd(raw: string, fallbackName: string): ParsedSkill {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: '', body: raw.trim() };
  const fm = m[1];
  const get = (k: string) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return {
    name: get('name') || fallbackName,
    description: get('description'),
    body: m[2].trim(),
  };
}

/** 按 agentskills.io 规范校验，返回错误列表（空 = 合法）。 */
export function validateSkill(s: {
  name: string;
  description: string;
  dirName: string;
}): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s.name)) {
    errors.push(`name 必须是小写字母/数字/连字符、1-64 字符: "${s.name}"`);
  }
  if (s.name !== s.dirName) {
    errors.push(`name "${s.name}" 必须与目录名 "${s.dirName}" 一致`);
  }
  if (!s.description) errors.push('description 必填');
  if (s.description.length > 1024) errors.push('description 超过 1024 字符');
  return errors;
}
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `npx jest src/skills/skill-parser.spec.ts`
Expected: PASS

### Task 3: absolutizeRefPaths 迁入 skills 模块

**Files:**
- Create: `apps/backend/src/skills/skill-files.ts`（从 `src/worker/skill-files.ts` 迁入，删掉 `buildSkillFiles`，保留 `absolutizeRefPaths` 与 `SkillFile` 类型，新增 `toFileData`）
- Create: `apps/backend/src/skills/skill-files.spec.ts`（把 `src/worker/skill-files.spec.ts` 中 absolutizeRefPaths 相关用例迁过来；buildSkillFiles 用例删除）
- Delete: `apps/backend/src/worker/skill-files.ts`、`apps/backend/src/worker/skill-files.spec.ts`（在 Task 10 worker 改完后再删，避免中间态编译失败）

- [ ] **Step 3.1: 新文件**（`absolutizeRefPaths` 原样拷贝，注释保留；追加：）

```typescript
import type { FileData } from 'deepagents';

/** 文本内容 → StoreBackend 的 FileData 值（content 按行数组 + 时间戳，dist 的 convertStoreItemToFileData 校验这三字段）。 */
export function toFileData(content: string, now: string): FileData {
  return { content: content.split('\n'), created_at: now, modified_at: now };
}
```

- [ ] **Step 3.2: 迁移测试用例并跑**

Run: `npx jest src/skills/skill-files.spec.ts`
Expected: PASS（absolutizeRefPaths 行为不变：`./references/x.md`、裸 `references/`、markdown 链接 `](./sub.md)` 三种写法都被改写为 `/skills/<name>/...`）

### Task 4: SkillsService（注册表：内置 + 用户安装 + DB 合并）

**Files:**
- Create: `apps/backend/src/skills/skills.service.ts`
- Test: `apps/backend/src/skills/skills.service.spec.ts`

接口（供补全 / worker / 播种共用，对齐设计 §3「接口按用户解析」）：

```typescript
export interface SkillDef {
  name: string;
  description: string;
  domain: string; // 命名约定 <domain>-<action>（沿用现状）
  source: 'builtin' | string; // builtin 或 github:... 串
  enabled: boolean;
  files: Record<string, string>; // 相对路径 → 内容（含 SKILL.md）
}
```

- [ ] **Step 4.1: 写失败测试**（用 `mock-fs` 不可取——项目无此依赖；用真实临时目录 `fs.mkdtempSync(os.tmpdir())` 搭 fixture）

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsService } from './skills.service';

const prismaMock = { skill: { findMany: jest.fn() } } as never;

function makeSkill(root: string, name: string, desc = 'd') {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\nbody`,
  );
}

describe('SkillsService.effectiveSkillsFor', () => {
  let builtinDir: string;
  let dataDir: string;
  let svc: SkillsService;

  beforeEach(() => {
    builtinDir = mkdtempSync(join(tmpdir(), 'builtin-'));
    dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    process.env.SKILLS_DIR = builtinDir;
    process.env.SKILLS_DATA_DIR = dataDir;
    svc = new SkillsService(prismaMock);
  });
  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('无安装技能时返回全部内置技能', async () => {
    makeSkill(builtinDir, 'tvc-director');
    prismaMock.skill.findMany.mockResolvedValue([]);
    const defs = await svc.effectiveSkillsFor('u1');
    expect(defs.map((d) => d.name)).toEqual(['tvc-director']);
    expect(defs[0].source).toBe('builtin');
  });

  it('用户已启用安装技能合并进来，且同名覆盖内置', async () => {
    makeSkill(builtinDir, 'docx', '内置版');
    makeSkill(join(dataDir, 'u1'), 'docx', '安装版');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'docx', enabled: true, source: 'github:a/b#p@main' },
    ]);
    const defs = await svc.effectiveSkillsFor('u1');
    expect(defs).toHaveLength(1);
    expect(defs[0].description).toBe('安装版');
  });

  it('disabled 的安装技能不返回', async () => {
    makeSkill(join(dataDir, 'u1'), 'pdf', 'x');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'pdf', enabled: false, source: 's' },
    ]);
    expect(await svc.effectiveSkillsFor('u1')).toHaveLength(0);
  });

  it('用户目录互相隔离', async () => {
    makeSkill(join(dataDir, 'u2'), 'pdf', 'x');
    prismaMock.skill.findMany.mockResolvedValue([]);
    expect(await svc.effectiveSkillsFor('u1')).toHaveLength(0);
  });

  it('listFor 含 disabled 行（管理页要能看见并重新启用）', async () => {
    makeSkill(join(dataDir, 'u1'), 'pdf', 'x');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'pdf', enabled: false, source: 's' },
    ]);
    const list = await svc.listFor('u1');
    expect(list.find((d) => d.name === 'pdf')?.enabled).toBe(false);
  });

  it('getFor 遵循同名覆盖（用户安装 > 内置）', async () => {
    makeSkill(builtinDir, 'docx', '内置版');
    makeSkill(join(dataDir, 'u1'), 'docx', '安装版');
    prismaMock.skill.findMany.mockResolvedValue([
      { name: 'docx', enabled: true, source: 's' },
    ]);
    expect((await svc.getFor('u1', 'docx'))?.description).toBe('安装版');
  });
});
```

- [ ] **Step 4.2: 确认失败** → `npx jest src/skills/skills.service.spec.ts` FAIL

- [ ] **Step 4.3: 实现**

要点（目录扫描逻辑从 `command-registry.service.ts` 的 `readSkillFiles`/`load` 迁入，保留 512KB/文件上限与 `.git`/`.DS_Store` 跳过）：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseSkillMd } from './skill-parser';

const builtinDir = () => process.env.SKILLS_DIR ?? join(process.cwd(), 'skills');
const dataDir = () => process.env.SKILLS_DATA_DIR ?? join(process.cwd(), 'data', 'skills');

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 该用户当前生效技能：内置 + 已启用安装（同名后者覆盖，对齐官方 §14.6 语义）。 */
  async effectiveSkillsFor(userId: string): Promise<SkillDef[]> {
    const map = new Map<string, SkillDef>();
    for (const def of this.scanDir(builtinDir(), 'builtin')) map.set(def.name, def);
    const rows = await this.prisma.skill.findMany({ where: { userId, enabled: true } });
    const userRoot = join(dataDir(), userId);
    for (const row of rows) {
      const def = this.scanOne(join(userRoot, row.name), row.source);
      if (def) map.set(def.name, def);
    }
    return [...map.values()];
  }

  /** 列表 API 用：内置 + 该用户全部安装行（含 disabled），剥掉 files 只回元数据。 */
  async listFor(userId: string): Promise<Omit<SkillDef, 'files'>[]> { /* 同 effectiveSkillsFor 但含 disabled 行、map 时剥 files */ }

  /** 按名取（用户视角，含覆盖语义），worker buildSkillPrompt 用。 */
  async getFor(userId: string, name: string): Promise<SkillDef | undefined> { /* effectiveSkillsFor 找 name */ }
}
```

（`scanDir`/`scanOne` 为私有方法：遍历目录→`readSkillFiles` 全量读文本→`parseSkillMd`。实现完整代码由执行者按现有 `command-registry.service.ts` 风格写，行为以测试为准。）

- [ ] **Step 4.4: 确认通过** → `npx jest src/skills/skills.service.spec.ts` PASS

### Task 5: skill-installer（GitHub tarball 下载/解压/校验/落盘）

**Files:**
- Create: `apps/backend/src/skills/skill-installer.ts`
- Test: `apps/backend/src/skills/skill-installer.spec.ts`
- 依赖：解压用 `tar` 包（`npm i tar` + `npm i -D @types/tar`，纯 JS、Nest 生态常用）

- [ ] **Step 5.1: 写失败测试**（fixture：用 `tar` 在 tmp 里现做一个 `<repo>-<ref>/<path>/SKILL.md` 结构的 tar.gz；下载函数注入 mock）

```typescript
import { extractSkillFromTarball } from './skill-installer';

describe('extractSkillFromTarball', () => {
  it('解出指定子目录、校验通过、落盘到目标目录', async () => { /* fixture 断言 SKILL.md 在 dest/<name>/SKILL.md */ });
  it('SKILL.md 缺失时报业务错', async () => { /* 期望 BusinessException */ });
  it('frontmatter 校验失败时报业务错并不落盘', async () => { /* name 与目录不一致 fixture */ });
  it('拒绝路径穿越（tar 内含 ../ 条目）', async () => { /* 恶意 fixture，期望拒绝 */ });
  it('单文件 >512KB 跳过、目录总量 >20MB 拒绝', async () => { /* 大文件 fixture */ });
});
```

- [ ] **Step 5.2: 确认失败**

- [ ] **Step 5.3: 实现**

要点：
- 下载 URL：`https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`（默认 ref `main`，404 时重试 `master`）。
- `tar.t`/`tar.x` 用 `filter` 只解 `<repo>-<ref>/<path>/` 前缀条目；`strip` 掉前缀；落到 `SKILLS_DATA_DIR/<userId>/<skillName>/`。
- 解压前检查条目路径含 `..` 或绝对路径 → 拒绝（路径穿越防护，设计 §8）。
- 落盘前先解到 tmp 目录、`parseSkillMd`+`validateSkill` 通过才 move 到目标（失败不留垃圾）。
- 返回 `{ name, description, source: 'github:<owner>/<repo>#<path>@<ref>' }` 供 DB 写入。
- 错误统一抛现有 `BusinessException`（`src/common/errors/`）。

- [ ] **Step 5.4: 确认通过** → `npx jest src/skills/skill-installer.spec.ts` PASS

### Task 6: skill-store.seed（diff 播种 InMemoryStore）

**Files:**
- Create: `apps/backend/src/skills/skill-store.seed.ts`
- Test: `apps/backend/src/skills/skill-store.seed.spec.ts`

- [ ] **Step 6.1: 写失败测试**

```typescript
import { InMemoryStore } from '@langchain/langgraph';
import { seedSkillsStore } from './skill-store.seed';

const def = (name: string, files: Record<string, string>) =>
  ({ name, description: 'd', domain: 'g', source: 'builtin', enabled: true, files });

describe('seedSkillsStore', () => {
  it('把技能文件播到 [userId,"skills"]，key 为 /skills/<name>/<rel>，SKILL.md 经 absolutize', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [
      def('tvc', { 'SKILL.md': '看 `./references/a.md`', 'references/a.md': 'A' }),
    ]);
    const items = await store.search(['u1', 'skills']);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['/skills/tvc/SKILL.md', '/skills/tvc/references/a.md']);
    const md = items.find((i) => i.key.endsWith('SKILL.md'))!.value as { content: string[] };
    expect(md.content.join('\n')).toContain('/skills/tvc/references/a.md'); // 相对路径已绝对化
  });

  it('diff 同步：移除不再生效技能的旧键、更新变更内容', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [def('a', { 'SKILL.md': 'v1' })]);
    await seedSkillsStore(store, 'u1', [def('b', { 'SKILL.md': 'x' })]);
    const keys = (await store.search(['u1', 'skills'])).map((i) => i.key);
    expect(keys).toEqual(['/skills/b/SKILL.md']);
  });

  it('namespace 按用户隔离', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [def('a', { 'SKILL.md': 'x' })]);
    expect(await store.search(['u2', 'skills'])).toEqual([]);
  });
});
```

- [ ] **Step 6.2: 确认失败**

- [ ] **Step 6.3: 实现**

```typescript
import type { BaseStore } from '@langchain/langgraph';
import { absolutizeRefPaths, toFileData } from './skill-files';
import type { SkillDef } from './skills.service';

/** worker 每 run 前调用：把该用户生效技能 diff 同步进 store（put 变更、delete 消失的键）。 */
export async function seedSkillsStore(
  store: BaseStore,
  userId: string,
  defs: SkillDef[],
): Promise<void> {
  const ns = [userId, 'skills'];
  const now = new Date().toISOString();
  const want = new Map<string, string>();
  for (const def of defs) {
    for (const [rel, content] of Object.entries(def.files)) {
      const injected = rel === 'SKILL.md' ? absolutizeRefPaths(def.name, content) : content;
      want.set(`/skills/${def.name}/${rel}`, injected);
    }
  }
  const existing = await store.search(ns, { limit: 1000 });
  if (existing.length >= 1000) throw new Error('skills namespace 超过 1000 键，diff 会漏删——先提高 limit');
  for (const item of existing) {
    if (!want.has(String(item.key))) await store.delete(ns, String(item.key));
  }
  for (const [key, content] of want) {
    const cur = existing.find((i) => String(i.key) === key);
    const lines = (cur?.value as { content?: string[] } | undefined)?.content;
    if (lines && lines.join('\n') === content) continue; // 未变不写，保留原时间戳
    await store.put(ns, key, toFileData(content, now));
  }
}
```

- [ ] **Step 6.4: 确认通过** → `npx jest src/skills/skill-store.seed.spec.ts` PASS

### Task 7: skills REST API + 模块装配 + commands/conversations 切换数据源

**Files:**
- Create: `apps/backend/src/skills/skills.controller.ts`、`apps/backend/src/skills/dto/install-skill.dto.ts`、`apps/backend/src/skills/skills.module.ts`（**`@Global()`**，镜像现有 CommandsModule 模式——ConversationsModule 无 imports，否则 Step 7.4 启动即 Nest DI 报错）
- Modify: `apps/backend/src/commands/commands.controller.ts`（数据源换 SkillsService，带 userId）、`apps/backend/src/commands/commands.module.ts`（imports SkillsModule）
- Modify: `apps/backend/src/conversations/conversations.service.ts`（**评审补强**：`assertKnownCommand` 现注入 CommandRegistryService 并 `commands.get(cmd.name)`，改为 `await skills.getFor(userId, cmd.name)`——否则用户安装技能在 POST /conversations 时会被当作未知命令拒绝）
- Modify: `apps/backend/src/app.module.ts`（注册 SkillsModule）
- **不删** `command-registry.service.ts`（worker 仍 import 它；统一在 Task 10 改完 worker 后删除，避免中间态编译失败）

- [ ] **Step 7.1: DTO + controller**

```typescript
// dto/install-skill.dto.ts
import { IsOptional, IsString, Matches } from 'class-validator';
export class InstallSkillDto {
  @IsString() @Matches(/^[\w.-]+\/[\w.-]+$/) repo!: string; // owner/repo
  @IsString() path!: string; // 仓库内子目录，如 document-skills/docx
  @IsOptional() @IsString() ref?: string;
}

// skills.controller.ts —— 路由对齐设计 §3 表格
// 注意：AuthUser 形状是 { userId, tenantId, email }（jwt-auth.guard.ts:9-13），没有 id 字段！
@Controller('skills')
@UseGuards(JwtAuthGuard)
export class SkillsController {
  // GET /skills        → listFor(user.userId)
  // POST /skills/install → installer 下载校验落盘 + prisma.skill.upsert({ where: { userId_name: { userId, name } } })
  // PATCH /skills/:name  → 先 prisma.skill.findUnique({ where: { userId_name } })，无行 → 404 业务码；有则 update enabled
  // DELETE /skills/:name → 先 findUnique 确认 DB 行存在（:name 来自 URL，未经 validateSkill 正则，
  //                        直接拼路径有 ..%2f 路径穿越风险）；存在才 rmSync(join(dataDir, userId, row.name)) + delete
}
```

userId 一律取自现有 `@CurrentUser()` 装饰器（`src/auth/current-user.decorator.ts`），字段名是 **`user.userId`**。

- [ ] **Step 7.2: commands 控制器与 conversations 服务切数据源**

```typescript
// commands.controller.ts
@Get()
async list(@CurrentUser() user: AuthUser) {
  const defs = await this.skills.listFor(user.userId);
  return defs.filter(d => d.enabled).map(({ name, description, domain }) => ({ name, description, domain }));
}
```

`conversations.service.ts` 的 `assertKnownCommand`（及其调用方）签名加 `userId`，内部改 `await this.skills.getFor(userId, name)` 判存在。

- [ ] **Step 7.3: 全量回归 + 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: 0 type errors；现有测试全绿（`agent.processor.spec.ts` 的 mock 在 Task 10 一并处理——本任务不动 worker）

- [ ] **Step 7.4: 启动冒烟**

Run: `npx nest start`（或 pm2 dev 配置），然后
`curl -H "Authorization: Bearer <dev token>" http://localhost:3101/skills`
Expected: 返回内置技能列表 JSON（`{code:0,data:[...]}` 信封）

---

## Chunk 2: Agent 装配 + Daytona 沙箱 + worker 接线

### Task 8: 沙箱工厂（per-thread find-or-create + StateBackend 回退）

**Files:**
- Create: `apps/backend/src/agent/sandbox.ts`
- 依赖：`npm i @langchain/daytona @daytonaio/sdk`

- [ ] **Step 8.1: 实现**（云资源工厂，不写单测；逻辑分支由 Task 10 的 worker 测试经 mock 覆盖）

```typescript
import { Daytona } from '@daytonaio/sdk';
import { DaytonaSandbox } from '@langchain/daytona';

/** 设计 §5：thread-scoped 沙箱。无 DAYTONA_API_KEY → 返回 null（调用方回退 StateBackend）。 */
export async function getThreadSandbox(threadId: string): Promise<DaytonaSandbox | null> {
  if (!process.env.DAYTONA_API_KEY) return null;
  const client = new Daytona(); // 自动读 DAYTONA_API_KEY
  let id: string;
  try {
    const existing = await client.findOne({ labels: { thread_id: threadId } });
    id = existing.id;
  } catch {
    const created = await DaytonaSandbox.create({
      labels: { thread_id: threadId },
      autoStopInterval: 15,      // 分钟；闲置即停，停机只付存储（免费额度保护）
      autoDeleteInterval: 60,    // 分钟；1h 后自动删除（设计 §5）
    });
    return created;
  }
  const sb = await DaytonaSandbox.fromId(id);
  if (!sb.isRunning) await sb.start(); // 停机沙箱续跑前显式拉起（设计 §5 停机恢复）
  return sb;
}

/** 只查不建（conversations 文件接口用）；不存在返回 null。
 *  找到后同样 fromId + isRunning 检查 + start()——停机沙箱直接 downloadFiles 会失败。 */
export async function findThreadSandbox(threadId: string): Promise<DaytonaSandbox | null> { /* try findOne → fromId → start-if-stopped；catch → null */ }
```

注意：`autoStopInterval`/`autoDeleteInterval` 单位以 @daytonaio/sdk 实际类型注释为准（实现时打开 `node_modules/@daytonaio/sdk` 的 d.ts 核对，分钟/秒不一致就改）。

- [ ] **Step 8.2: 类型检查** → `npx tsc --noEmit -p tsconfig.json` 0 errors

### Task 9: agent.factory 重构（CompositeBackend + 只读 /skills/ + 同步中间件 + 条件 execute 守则）

**Files:**
- Modify: `apps/backend/src/agent/agent.factory.ts`
- Create: `apps/backend/src/agent/skills-backend.ts`（只读 StoreBackend + 同步中间件，便于单测）
- Test: `apps/backend/src/agent/skills-backend.spec.ts`

- [ ] **Step 9.1: 写失败测试**

```typescript
import { ReadOnlyStoreBackend, buildSkillSyncFiles } from './skills-backend';

describe('ReadOnlyStoreBackend', () => {
  it('write/edit 返回 error 不落库', async () => {
    const b = new ReadOnlyStoreBackend({ namespace: () => ['u', 'skills'] });
    expect((await b.write('/skills/x/SKILL.md', 'hack')).error).toMatch(/read-only/);
    expect((await b.edit('/skills/x/SKILL.md', 'a', 'b')).error).toMatch(/read-only/);
  });
});

describe('buildSkillSyncFiles', () => {
  it('store items → uploadFiles 入参 [key, bytes]', async () => {
    /* InMemoryStore put 两个键 → 期望 [['/skills/a/SKILL.md', Uint8Array], ...] */
  });
});
```

- [ ] **Step 9.2: 确认失败**

- [ ] **Step 9.3: 实现 skills-backend.ts**

```typescript
import { StoreBackend, type WriteResult, type EditResult } from 'deepagents';
import type { BaseStore } from '@langchain/langgraph';

/** /skills/ 路由只读（官方 §9.5 policy hook 模式）：防 agent 跨线程污染技能库（设计·关键时序）。 */
export class ReadOnlyStoreBackend extends StoreBackend {
  async write(filePath: string): Promise<WriteResult> {
    return { error: `${filePath} is read-only (skills library)` } as WriteResult;
  }
  async edit(filePath: string): Promise<EditResult> {
    return { error: `${filePath} is read-only (skills library)` } as EditResult;
  }
}

/** beforeAgent 同步用：store 该用户 namespace 全部技能文件 → uploadFiles 入参。 */
export async function buildSkillSyncFiles(
  store: BaseStore,
  userId: string,
): Promise<Array<[string, Uint8Array]>> {
  const enc = new TextEncoder();
  const items = await store.search([userId, 'skills'], { limit: 1000 });
  return items.map((i) => [
    String(i.key),
    enc.encode(((i.value as { content: string[] }).content ?? []).join('\n')),
  ]);
}
```

（`write`/`edit` 覆写签名以 deepagents 实际 d.ts 为准——若基类是多参，覆写保持兼容、忽略多余参数。）

- [ ] **Step 9.4: 确认通过** → `npx jest src/agent/skills-backend.spec.ts` PASS

- [ ] **Step 9.5: 改 agent.factory.ts**

```typescript
import { CompositeBackend, StateBackend } from 'deepagents';
import type { BaseStore } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { ReadOnlyStoreBackend, buildSkillSyncFiles } from './skills-backend';

export interface BuildAgentOptions {
  checkpointer?: unknown;
  systemPromptExtra?: string;
  model?: string;
  /** worker 构建的默认后端：DaytonaSandbox（有 key）或 new StateBackend()（回退）。 */
  defaultBackend: unknown;
  /** worker 持有的进程级 InMemoryStore（skills 播种目标）。 */
  store: BaseStore;
  /** 默认后端是否沙箱（决定 execute 守则注入与同步中间件启用）。 */
  hasSandbox: boolean;
}

const contextSchema = z.object({
  activePlan: z.string().optional(),
  userId: z.string(), // 必填：缺失即 schema 校验失败，杜绝静默共享（设计·关键时序）
});

export function buildAgent(opts: BuildAgentOptions): any {
  const model = new ChatGoogleGenerativeAI({ /* 不变 */ });

  const skillsBackend = new ReadOnlyStoreBackend({
    // dist 已核实：工厂入参是 { state, config, assistantId }，userId 走 config.configurable
    namespace: ({ config }: { config?: { configurable?: { userId?: string } } }) => {
      const userId = config?.configurable?.userId;
      if (!userId) throw new Error('userId missing in configurable（worker 必须传）');
      return [userId, 'skills'];
    },
  });

  const backend = new CompositeBackend(opts.defaultBackend as never, {
    '/skills/': skillsBackend,
  });

  // 官方 §14.8 模式：beforeAgent 把 store 里该用户技能文件上传进沙箱，execute 才能跑 scripts/*
  const skillSandboxSync = createMiddleware({
    name: 'skillSandboxSyncMiddleware',
    beforeAgent: async (_state: unknown, runtime: { context?: { userId?: string } }) => {
      const userId = runtime?.context?.userId;
      if (!userId) return;
      const files = await buildSkillSyncFiles(opts.store, userId);
      if (files.length > 0) await backend.uploadFiles(files);
    },
  });

  return createDeepAgent({
    model,
    systemPrompt: buildSystemPrompt(opts.hasSandbox) + (opts.systemPromptExtra ?? ''),
    tools: [getWeatherTool, sendEmailTool],
    backend,
    store: opts.store as never,
    skills: ['/skills/'],
    contextSchema,
    middleware: [
      ...(opts.hasSandbox ? [skillSandboxSync] : []),
      planContinuationMiddleware,
      skillReadPolicyMiddleware,
    ],
    interruptOn: { send_email: true },
    checkpointer: opts.checkpointer as never,
  });
}
```

实现时核对点（以包为准）：
1. `createMiddleware` 的 `beforeAgent` 回调签名（langchain 当前版本）——若是 `(state, runtime)` 之外的形态，按 d.ts 调整。
2. `createDeepAgent` 是否接受 `store` 选项直传（官方 §14.4 示例有 `store`）；若没有则 InMemoryStore 经 `agent.stream(..., { store })` 或 compile 选项传——打开 deepagents d.ts 确认。
3. `CompositeBackend` 构造第一参类型（BackendProtocol），DaytonaSandbox 实例应直接可用（`isSandboxBackend` 导出存在）。

- [ ] **Step 9.6: SYSTEM_PROMPT 重写（主会话执行，调 /optimize-agent-prompt skill）**

`buildSystemPrompt(hasSandbox: boolean)` 拆两段：基础段（角色、斜杠命令、progressive disclosure 策略——收编现 SYSTEM_PROMPT 全部语义）+ 沙箱段（仅 `hasSandbox` 时拼上：execute 工具守则、跑 scripts 前先读 SKILL.md 指示、产物写入工作区、pip/npm 依赖安装提示）。
**此步骤由主会话调用 `/optimize-agent-prompt` skill 完成评分与改写**（用户明确要求），产出替换 `SYSTEM_PROMPT` 常量；多轮防重读与 plan 回注文案不动。

- [ ] **Step 9.7: 类型检查** → `npx tsc --noEmit -p tsconfig.json` 0 errors

### Task 10: worker 接线（播种 + 沙箱 + userId + 移除全量注入）

**Files:**
- Modify: `apps/backend/src/worker/agent.processor.ts`
- Modify: `apps/backend/src/worker/worker.module.ts`（imports SkillsModule + store provider）
- Create: `apps/backend/src/skills/skill-store.provider.ts`（进程级 InMemoryStore 的 Nest provider，token `SKILLS_STORE`）
- Modify: `apps/backend/src/worker/agent.processor.spec.ts`
- Delete: `apps/backend/src/worker/skill-files.ts`、`skill-files.spec.ts`（Task 3 已迁出）；`apps/backend/src/commands/command-registry.service.ts`、`command-registry.service.spec.ts`（Task 7 已切走全部消费方，此处删最后的 worker import）

- [ ] **Step 10.1: processor 改造**

**作用域（评审补强）**：下面 ①–④ 放在 **run/resume 共用作用域**（即现有 `conv = prisma.conversation.update` 之后、`kind === 'resume'` 分支判断之外）——resume 续跑同样要播种与沙箱：worker 重启后 InMemoryStore 为空，若播种只在 run 分支，审批恢复时 `[userId,"skills"]` namespace 为空、技能静默失效。仅 `input` 构造、`systemPromptExtra`、移除 `files` 注入属于 run 分支。

```typescript
const conv = await this.prisma.conversation.update({ /* 不变，conv.userId 非空（schema 已核实） */ });

// ① 播种：该用户生效技能 → InMemoryStore（diff 同步，设计·关键时序）
const defs = await this.skills.effectiveSkillsFor(conv.userId);
await seedSkillsStore(this.store, conv.userId, defs);

// ② 沙箱：thread-scoped find-or-create；无 key 回退 StateBackend
const sandbox = await getThreadSandbox(conversationId);
const defaultBackend = sandbox ?? new StateBackend();

// ③ 装配（backend/store 传入；不再注入 files）
const agent = buildAgent({
  checkpointer: this.checkpointer,
  systemPromptExtra,
  model: conv.model ?? undefined,
  defaultBackend,
  store: this.store,
  hasSandbox: !!sandbox,
});

// ④ stream config：userId 同时进 configurable（StoreBackend namespace 用）与 context（中间件用）
const stream = await agent.stream(input, {
  configurable: { thread_id: conversationId, userId: conv.userId },
  context: { activePlan, userId: conv.userId },
  /* 其余不变 */
});
```

- `input = { messages }`（删掉 `files` 注入与 `buildSkillFiles` import）。
- `buildSkillPrompt` 改为 `await this.skills.getFor(conv.userId, cmd.name)`（接口含 files，SKILL.md 全文注入逻辑不变，函数 sync→async）；**第二处调用点**：runName 标注循环里的 `this.commands.get(cmd.name)`（现 agent.processor.ts:89）同样换 `skills.getFor`。
- 沙箱创建抛错时：catch → 降级 `new StateBackend()` + 推一条 `message` 事件「本轮无沙箱执行能力」（设计 §8）。

- [ ] **Step 10.2: 更新 processor 测试**

`agent.processor.spec.ts` 现有 mock 体系下：CommandRegistryService mock 换 SkillsService mock（`effectiveSkillsFor`/`getFor`）；新增断言：
- `seedSkillsStore` 以 `(store, userId, defs)` 被调
- `buildAgent` 收到 `hasSandbox:false`（测试环境无 key）且 stream config 的 `configurable.userId` 正确
- 不再向 input 传 `files`

- [ ] **Step 10.3: 全量回归** → `npx tsc --noEmit -p tsconfig.json && npx jest` 全绿

### Task 11: 会话产物文件接口

**Files:**
- Modify: `apps/backend/src/conversations/conversations.controller.ts`、`conversations.service.ts`

- [ ] **Step 11.1: 实现**（设计 §6）

```
GET /conversations/:id/files          → findThreadSandbox(id)；null → BusinessException 404
                                        有则 execute('find /home -maxdepth 3 -type f') 或 backend glob 列工作区文件（排除 /skills/）
GET /conversations/:id/files?path=... → downloadFiles([path])[0] → { path, contentBase64 }
```

校验会话属于当前用户（现有 conversations.service 的归属检查模式）。

- [ ] **Step 11.2: 类型检查 + 现有测试回归**

---

## Chunk 3: 前端最小页 + 开源技能实测

### Task 12: 前端 /skills 页

**Files:**
- Modify: `apps/frontend/src/lib/api.ts`（追加 listSkills/installSkill/toggleSkill/deleteSkill，沿用 request 信封）
- Create: `apps/frontend/src/app/skills/page.tsx`、`apps/frontend/src/app/skills/_components/skill-card.tsx`、`install-form.tsx`

- [ ] **Step 12.1: 先读 Next.js 本地文档**（`apps/frontend/AGENTS.md` 要求：写码前读 `node_modules/next/dist/docs/` 相关章节——本版本 API 可能与训练数据不同）

- [ ] **Step 12.2: 实现**

约束（CLAUDE.md §6/§7）：只用语义 tokens（`bg-card`/`text-muted-foreground`/`border-border`...），shadcn/ui 原语（card/badge/button/input/separator；启停控件先 `npx shadcn@latest add switch` 安装 Switch——启停的规范控件，符合 §6「shadcn 默认」）；图标 lucide-react；布局对齐 `demo/template`。
内容：技能列表（名称、description、来源 badge：内置/GitHub、启停按钮、删除按钮——内置技能无操作按钮）+「从 GitHub 安装」表单（repo/path/ref 三输入 + 提交）。
mount 守卫如需用 `useSyncExternalStore`（项目 lint 禁 `useEffect(()=>setMounted(true))`）。

- [ ] **Step 12.3: 浏览器验证**

preview 起前端 → 登录 → /skills 页：列表渲染、安装一个技能、启停切换、删除。截图留档。
（用完 preview_resize 必须恢复 desktop 视口——项目记忆约定。）

### Task 13: 拉开源技能实测（两条链路验收）

- [ ] **Step 13.1: 确认仓库内路径**

先 `curl -sL https://api.github.com/repos/anthropics/skills/contents/` 看顶层目录，确认 docx/xlsx 的真实子路径（如 `document-skills/docx`），不要臆测。

- [ ] **Step 13.2: 经 API 安装**

`POST /skills/install` 安装：① anthropics/skills 的 docx（python 脚本 + reference，双链路）② 一个社区纯文档技能（如 obra/superpowers 仓库里的 brainstorming——验证 reference 按需加载与子文件路由）。
Expected: GET /skills 出现两条 enabled 记录；`SKILLS_DATA_DIR/<userId>/` 落盘。

- [ ] **Step 13.3: e2e 链路 A——progressive disclosure**

新会话发 `/docx 帮我写一份 docx 说明`（或自然语言命中）。观察消息流：模型先 read_file `/skills/docx/SKILL.md`，随后按需 read_file reference 子文件，**不**一次读全部。
Expected: tool 卡顺序符合；无 File not found（absolutize 生效）。

- [ ] **Step 13.4: e2e 链路 B——沙箱执行脚本**（需用户已配 DAYTONA_API_KEY）

会话内让 agent 用 docx 技能真实产出一个 .docx：观察 `execute` 工具调用（pip install + 跑 scripts），完成后 `GET /conversations/:id/files` 列出产物、`?path=` 能下载。
Expected: execute 退出码 0；产物可下载非空。

- [ ] **Step 13.5: 回退路径验证**

去掉 DAYTONA_API_KEY 重启 worker，同样会话流程：技能列表/补全/SKILL.md 加载照常（StoreBackend 在 host），系统提示无 execute 守则段，agent 不调用 execute。

### Task 14: 收尾

- [ ] **Step 14.1: 全量验证**

Run: `cd apps/backend && npx tsc --noEmit -p tsconfig.json && npx jest`（node 22）
Run: `cd apps/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: 全绿。

- [ ] **Step 14.2: 文档更新**

`.claude/skills/deepagents-dev` 的「本项目如何接线」表若引用了被删文件（`worker/skill-files.ts`、`command-registry.service.ts`），更新指向新位置。README 增补 env：`DAYTONA_API_KEY`、`SKILLS_DATA_DIR`。

- [ ] **Step 14.3: 向用户汇报**（含 Verification 节，列全部命令输出与 file:line 引证），由用户决定 commit。
