import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CanvasSkillsService,
  MAX_INSTRUCTIONS_CHARS,
  upsertSkillDef,
} from './canvas-skills.service';

interface Row {
  id: string;
  userId: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  updatedAt: Date;
}

/** 最小内存版 prisma.canvasSkill：只实现 service 用到的几个方法 */
function fakePrisma(rows: Row[] = []) {
  const key = (w: { userId_name: { userId: string; name: string } }) =>
    rows.find(
      (r) => r.userId === w.userId_name.userId && r.name === w.userId_name.name,
    );
  const canvasSkill = {
    findMany: jest.fn(({ where }: { where: { userId: string } }) =>
      Promise.resolve(
        rows
          .filter((r) => r.userId === where.userId)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    ),
    findUnique: jest.fn(
      ({
        where,
      }: {
        where: { userId_name: { userId: string; name: string } };
      }) => Promise.resolve(key(where) ?? null),
    ),
    upsert: jest.fn(
      ({
        where,
        create,
        update,
      }: {
        where: { userId_name: { userId: string; name: string } };
        create: Omit<Row, 'id' | 'enabled' | 'updatedAt'>;
        update: Partial<Row>;
      }) => {
        const hit = key(where);
        if (hit) {
          Object.assign(hit, update, { updatedAt: new Date() });
          return Promise.resolve(hit);
        }
        const row = {
          ...create,
          id: `id${rows.length}`,
          enabled: true,
          updatedAt: new Date(),
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
        where: { userId_name: { userId: string; name: string } };
        data: Partial<Row>;
      }) => {
        Object.assign(key(where) ?? {}, data);
        return Promise.resolve({});
      },
    ),
    delete: jest.fn(
      ({
        where,
      }: {
        where: { userId_name: { userId: string; name: string } };
      }) => {
        const hit = key(where);
        if (hit) rows.splice(rows.indexOf(hit), 1);
        return Promise.resolve({});
      },
    ),
  };
  return { prisma: { canvasSkill } as unknown as PrismaService, rows };
}

describe('CanvasSkillsService', () => {
  let dir: string;
  const prev = process.env.CANVAS_SKILLS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-skills-'));
    mkdirSync(join(dir, 'skills-creator', 'references'), { recursive: true });
    writeFileSync(
      join(dir, 'skills-creator', 'SKILL.md'),
      '---\nname: skills-creator\ndescription: 创建技能\n---\n\n正文',
    );
    writeFileSync(
      join(dir, 'skills-creator', 'references', 'caps.md'),
      '能力清单',
    );
    process.env.CANVAS_SKILLS_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.CANVAS_SKILLS_DIR = prev;
  });

  it('内置技能带上全部文件，排在用户技能之前', async () => {
    const { prisma } = fakePrisma([
      {
        id: '1',
        userId: 'u1',
        name: 'a-teaser',
        description: 'd',
        content: 'md',
        enabled: true,
        updatedAt: new Date(),
      },
    ]);
    const svc = new CanvasSkillsService(prisma);
    const all = await svc.effectiveFor('u1');
    expect(all.map((s) => [s.name, s.kind])).toEqual([
      ['skills-creator', 'builtin'],
      ['a-teaser', 'user'],
    ]);
    expect(Object.keys(all[0].files).sort()).toEqual([
      'SKILL.md',
      'references/caps.md',
    ]);
  });

  it('停用的技能不进运行时，但管理列表里还在', async () => {
    const { prisma } = fakePrisma([
      {
        id: '1',
        userId: 'u1',
        name: 'off',
        description: 'd',
        content: 'md',
        enabled: false,
        updatedAt: new Date(),
      },
    ]);
    const svc = new CanvasSkillsService(prisma);
    expect((await svc.effectiveFor('u1')).map((s) => s.name)).toEqual([
      'skills-creator',
    ]);
    expect((await svc.listFor('u1')).map((s) => s.name)).toEqual([
      'skills-creator',
      'off',
    ]);
  });

  it('save：合法 → 新建；再存同名 → 覆盖并重新启用', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new CanvasSkillsService(prisma);
    const input = {
      name: 'product-teaser',
      description: '产品预告片',
      instructions: '# 步骤',
    };
    await expect(svc.save('u1', input)).resolves.toMatchObject({
      ok: true,
      name: 'product-teaser',
      created: true,
      // 带回存下的那份，运行中直接并进技能库
      skill: { name: 'product-teaser', kind: 'user', enabled: true },
    });
    expect(rows[0].content).toContain('name: product-teaser');
    rows[0].enabled = false;
    await expect(
      svc.save('u1', { ...input, instructions: '# 新步骤' }),
    ).resolves.toMatchObject({
      ok: true,
      name: 'product-teaser',
      created: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('# 新步骤');
    expect(rows[0].enabled).toBe(true);
  });

  it('save：名称不合规 / 与内置重名 / 正文为空 → 返回可读错误，不落库', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new CanvasSkillsService(prisma);
    const bad = await svc.save('u1', {
      name: 'Bad Name',
      description: 'd',
      instructions: 'x',
    });
    expect(bad.ok).toBe(false);
    const builtin = await svc.save('u1', {
      name: 'skills-creator',
      description: 'd',
      instructions: 'x',
    });
    expect(builtin).toEqual({
      ok: false,
      errors: [expect.stringContaining('内置技能')],
    });
    const empty = await svc.save('u1', {
      name: 'ok-name',
      description: 'd',
      instructions: '  ',
    });
    expect(empty.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('save：正文超长 → 返回可读错误，不落库', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new CanvasSkillsService(prisma);
    const r = await svc.save('u1', {
      name: 'too-long',
      description: 'd',
      instructions: 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1),
    });
    expect(r).toEqual({
      ok: false,
      errors: [expect.stringContaining('太长')],
    });
    expect(rows).toHaveLength(0);
  });

  it('内置技能只读一次磁盘：之后的调用走缓存；换目录才重读', async () => {
    const svc = new CanvasSkillsService(fakePrisma().prisma);
    const first = svc.builtins();
    expect(svc.builtins()).toBe(first);
    await svc.listFor('u1');
    expect(svc.builtins()).toBe(first);
    const other = mkdtempSync(join(tmpdir(), 'canvas-skills-'));
    process.env.CANVAS_SKILLS_DIR = other;
    expect(svc.builtins()).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it('upsertSkillDef：同名替换，内置在前、用户按名称', () => {
    const def = (name: string, kind: 'builtin' | 'user') => ({
      name,
      description: '',
      kind,
      enabled: true,
      updatedAt: null,
      files: { 'SKILL.md': name },
    });
    const merged = upsertSkillDef(
      [def('skills-creator', 'builtin'), def('b-skill', 'user')],
      def('a-skill', 'user'),
    );
    expect(merged.map((d) => d.name)).toEqual([
      'skills-creator',
      'a-skill',
      'b-skill',
    ]);
    const replaced = upsertSkillDef(merged, {
      ...def('a-skill', 'user'),
      files: { 'SKILL.md': 'v2' },
    });
    expect(replaced).toHaveLength(3);
    expect(replaced[1].files['SKILL.md']).toBe('v2');
  });

  it('内置技能不能删除、不能停用（403）', async () => {
    const svc = new CanvasSkillsService(fakePrisma().prisma);
    for (const op of [
      () => svc.remove('u1', 'skills-creator'),
      () => svc.setEnabled('u1', 'skills-creator', false),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(BusinessException);
      await op().catch((e: BusinessException) =>
        expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN),
      );
    }
  });

  it('用户技能可停用、可删除；不存在的 404；别人的看不到', async () => {
    const { prisma, rows } = fakePrisma([
      {
        id: '1',
        userId: 'u1',
        name: 'mine',
        description: 'd',
        content: 'md',
        enabled: true,
        updatedAt: new Date(),
      },
    ]);
    const svc = new CanvasSkillsService(prisma);
    await svc.setEnabled('u1', 'mine', false);
    expect(rows[0].enabled).toBe(false);
    await expect(svc.remove('u2', 'mine')).rejects.toBeInstanceOf(
      BusinessException,
    );
    await svc.remove('u1', 'mine');
    expect(rows).toHaveLength(0);
    await expect(svc.detailFor('u1', 'mine')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('detail：内置给出文件列表与 SKILL.md 原文', async () => {
    const svc = new CanvasSkillsService(fakePrisma().prisma);
    const d = await svc.detailFor('u1', 'skills-creator');
    expect(d.files).toEqual(['SKILL.md', 'references/caps.md']);
    expect(d.content).toContain('name: skills-creator');
    expect(d.kind).toBe('builtin');
  });

  it('真实内置目录里有 skills-creator，且 frontmatter 合规', async () => {
    process.env.CANVAS_SKILLS_DIR = join(
      __dirname,
      '..',
      '..',
      'canvas-skills',
    );
    const svc = new CanvasSkillsService(fakePrisma().prisma);
    const [creator] = svc.builtins();
    expect(creator.name).toBe('skills-creator');
    expect(creator.description.length).toBeGreaterThan(20);
    expect(creator.description.length).toBeLessThanOrEqual(1024);
    expect(Object.keys(creator.files)).toEqual(
      expect.arrayContaining([
        'SKILL.md',
        'references/canvas-capabilities.md',
        'references/video-workflow-example.md',
      ]),
    );
  });
});
