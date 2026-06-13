import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
