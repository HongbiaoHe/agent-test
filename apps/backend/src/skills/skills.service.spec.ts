import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '../common/errors/error-code';
import { SkillsService } from './skills.service';

// 具体类型保留 skill.findMany 的 jest.Mock 形状，注入处再断言成 PrismaService（never 可赋给任意参数）
const prismaMock = { skill: { findMany: jest.fn() } };

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
    svc = new SkillsService(prismaMock as never);
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
    expect(defs[0].kind).toBe('builtin');
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
    expect(d?.kind).toBe('github');
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

describe('SkillsService 手写技能（custom）', () => {
  let builtinDir: string;
  let dataDir: string;
  let svc: SkillsService;
  /** 内存版 Skill 表：create / findUnique / update 都落在它上面，findMany 读它（与运行时链路联动） */
  let rows: {
    name: string;
    description: string;
    source: string;
    enabled: boolean;
  }[];
  const prisma = {
    skill: {
      findMany: jest.fn(() => Promise.resolve(rows)),
      findUnique: jest.fn(
        ({ where }: { where: { userId_name: { name: string } } }) =>
          Promise.resolve(
            rows.find((r) => r.name === where.userId_name.name) ?? null,
          ),
      ),
      create: jest.fn(
        ({ data }: { data: (typeof rows)[number] & { userId: string } }) => {
          const row = {
            name: data.name,
            description: data.description,
            source: data.source,
            enabled: data.enabled,
          };
          rows.push(row);
          return Promise.resolve(row);
        },
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { userId_name: { name: string } };
          data: { description: string };
        }) => {
          const row = rows.find((r) => r.name === where.userId_name.name)!;
          row.description = data.description;
          return Promise.resolve(row);
        },
      ),
    },
  };

  beforeEach(() => {
    builtinDir = mkdtempSync(join(tmpdir(), 'builtin-'));
    dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    process.env.SKILLS_DIR = builtinDir;
    process.env.SKILLS_DATA_DIR = dataDir;
    rows = [];
    svc = new SkillsService(prisma as never);
  });
  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('新建：落 SKILL.md（frontmatter + 正文），运行时有效技能里能取到，kind=custom', async () => {
    const info = await svc.createCustom('u1', {
      name: 'weekly-report',
      description: '写周报\n按公司模板',
      body: '# 周报\n\n1. 本周进展',
    });
    expect(info).toMatchObject({
      name: 'weekly-report',
      kind: 'custom',
      source: 'custom',
    });

    const md = readFileSync(
      join(dataDir, 'u1', 'weekly-report', 'SKILL.md'),
      'utf8',
    );
    // 多行说明压成一行，否则 parseSkillMd 只读到第一行
    expect(md).toBe(
      '---\nname: weekly-report\ndescription: 写周报 按公司模板\n---\n\n# 周报\n\n1. 本周进展\n',
    );

    const def = await svc.getFor('u1', 'weekly-report');
    expect(def?.kind).toBe('custom');
    expect(def?.description).toBe('写周报 按公司模板');
    expect(def?.files['SKILL.md']).toBe(md);

    const detail = await svc.detailFor('u1', 'weekly-report');
    expect(detail?.body).toBe('# 周报\n\n1. 本周进展');
  });

  it('名字被内置技能或自己已有技能占用 → SKILL_NAME_TAKEN(409)，不落盘', async () => {
    makeSkill(builtinDir, 'tvc-director');
    await expect(
      svc.createCustom('u1', {
        name: 'tvc-director',
        description: 'd',
        body: 'b',
      }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.SKILL_NAME_TAKEN.code,
      status: 409,
    });

    rows.push({
      name: 'pdf',
      description: 'x',
      source: 'github:a/b#p@main',
      enabled: true,
    });
    await expect(
      svc.createCustom('u1', { name: 'pdf', description: 'd', body: 'b' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.SKILL_NAME_TAKEN.code });
    expect(prisma.skill.create).not.toHaveBeenCalled();
  });

  it('修改：重写 SKILL.md 与说明，运行时读到新内容', async () => {
    await svc.createCustom('u1', {
      name: 'memo',
      description: '旧',
      body: '旧正文',
    });
    await svc.updateCustom('u1', 'memo', {
      description: '新说明',
      body: '新正文',
    });
    const def = await svc.getFor('u1', 'memo');
    expect(def?.description).toBe('新说明');
    expect(def?.files['SKILL.md']).toContain('新正文');
  });

  it('只有手写技能能改：GitHub 安装的 → SKILL_NOT_EDITABLE；不存在的 → SKILL_NOT_FOUND', async () => {
    rows.push({
      name: 'pdf',
      description: 'x',
      source: 'github:a/b#p@main',
      enabled: true,
    });
    await expect(
      svc.updateCustom('u1', 'pdf', { description: 'd', body: 'b' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.SKILL_NOT_EDITABLE.code });
    await expect(
      svc.updateCustom('u1', 'nope', { description: 'd', body: 'b' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.SKILL_NOT_FOUND.code });
  });
});
