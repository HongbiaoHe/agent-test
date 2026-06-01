import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistryService } from './command-registry.service';

describe('CommandRegistryService', () => {
  let dir: string;
  const prevEnv = process.env.SKILLS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    const skill = join(dir, 'demo-skill');
    mkdirSync(join(skill, 'references'), { recursive: true });
    mkdirSync(join(skill, '.git'), { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示技能\n---\n# Demo\n见 references/guide.md',
    );
    writeFileSync(join(skill, 'references', 'guide.md'), '# Guide\n参考正文');
    writeFileSync(join(skill, '.git', 'HEAD'), 'ref: refs/heads/main');
    process.env.SKILLS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SKILLS_DIR;
    else process.env.SKILLS_DIR = prevEnv;
  });

  it('加载技能目录下的全部文本文件（含 references/**），跳过 .git', () => {
    const svc = new CommandRegistryService();
    svc.load();

    const def = svc.get('demo-skill');
    expect(def).toBeDefined();
    expect(def!.description).toBe('演示技能');

    // 顶层 SKILL.md 与子目录 references 都被读入，供 worker 注入 StateBackend
    expect(Object.keys(def!.files).sort()).toEqual([
      'SKILL.md',
      'references/guide.md',
    ]);
    expect(def!.files['references/guide.md']).toContain('参考正文');
    // .git 内文件不应被注入
    const hasGitFiles = Object.keys(def!.files).some((k) =>
      k.startsWith('.git'),
    );
    expect(hasGitFiles).toBe(false);
  });

  it('list() 不泄露 raw / files，仅返回补全所需字段', () => {
    const svc = new CommandRegistryService();
    svc.load();
    const items = svc.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      name: 'demo-skill',
      description: '演示技能',
      domain: 'demo',
    });
  });
});
