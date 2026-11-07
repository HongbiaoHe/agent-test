import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from './db/conversations';
import { openDatabase } from './db/database';
import { McpError, McpStore, sandboxOrigin, validateMcpUrl } from './mcp/mcp-store';
import { parseSkillSource, skillsAddArgs } from './skills/github-install';
import { createSaveSkillTool } from './skills/save-skill.tool';
import { SkillInstallError, SkillStore } from './skills/skill-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-skills-mcp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('技能来源解析（兼容 npx skills add）', () => {
  it('识别安装命令的几种写法', () => {
    expect(skillsAddArgs('/skills add anthropics/skills')).toBe('anthropics/skills');
    expect(skillsAddArgs('npx skills add a/b --skill x')).toBe('a/b --skill x');
    expect(skillsAddArgs('npx -y skills add a/b')).toBe('a/b');
    expect(skillsAddArgs('/skills-helper do it')).toBeNull();
    expect(skillsAddArgs('帮我装个技能')).toBeNull();
  });

  it('owner/repo、@skill、--skill、子路径', () => {
    expect(parseSkillSource('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: undefined,
      path: undefined,
      skills: [],
    });
    expect(parseSkillSource('vercel-labs/agent-skills@frontend-design').skills).toEqual(['frontend-design']);
    expect(parseSkillSource('a/b --skill x -s y,z -y -g --agent claude-code').skills).toEqual(['x', 'y', 'z']);
    expect(parseSkillSource('a/b/skills/pdf')).toMatchObject({ path: 'skills/pdf' });
  });

  it('GitHub 链接：tree / blob / .git / ssh', () => {
    expect(parseSkillSource('https://github.com/a/b/tree/dev/skills/x')).toMatchObject({
      owner: 'a',
      repo: 'b',
      ref: 'dev',
      path: 'skills/x',
    });
    expect(parseSkillSource('https://github.com/a/b/blob/main/x/SKILL.md')).toMatchObject({ ref: 'main', path: 'x' });
    expect(parseSkillSource('https://github.com/a/b.git')).toMatchObject({ repo: 'b' });
    expect(parseSkillSource('git@github.com:a/b.git')).toMatchObject({ owner: 'a', repo: 'b' });
  });

  it('拒绝非 GitHub 地址、缺仓库与路径穿越', () => {
    expect(() => parseSkillSource('https://gitlab.com/a/b')).toThrow('只支持 GitHub');
    expect(() => parseSkillSource('--skill x')).toThrow('缺少要安装的仓库');
    expect(() => parseSkillSource('a/b/../../etc')).toThrow('不能包含');
  });
});

describe('技能库', () => {
  async function builtinRoot() {
    const root = join(dir, 'builtin');
    await mkdir(join(root, 'create-skills'), { recursive: true });
    await writeFile(join(root, 'create-skills', 'SKILL.md'), '---\nname: create-skills\ndescription: 建技能\n---\nbody');
    return root;
  }

  it('内置技能：列在最前、始终启用、不能停用 / 删除 / 被同名覆盖，同步进运行目录', async () => {
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'), await builtinRoot());
    await store.saveCustom({ name: 'weekly', description: '写周报', body: '步骤' });
    const list = await store.list();
    expect(list.map((s) => [s.name, s.kind])).toEqual([
      ['create-skills', 'builtin'],
      ['weekly', 'custom'],
    ]);
    await expect(store.setEnabled('create-skills', false)).rejects.toBeInstanceOf(SkillInstallError);
    await expect(store.remove('create-skills')).rejects.toBeInstanceOf(SkillInstallError);
    await expect(store.saveCustom({ name: 'create-skills', description: 'x', body: 'y' })).rejects.toThrow('内置技能');
    const runtime = join(dir, 'runtime');
    expect(await store.syncToRuntime(runtime)).toEqual(['create-skills', 'weekly']);
    expect(existsSync(join(runtime, 'skills', 'create-skills', 'SKILL.md'))).toBe(true);
  });

  it('随应用发布的内置技能（resources/skills）全部合法、能同步进运行目录，且不含 BuzzVideo 专有机制', async () => {
    const resources = join(__dirname, '..', '..', 'resources', 'skills');
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'), resources);
    // 不合法的内置技能会被静默跳过，这里逐个点名
    expect((await store.list()).map((s) => [s.name, s.kind])).toEqual(
      ['audio-producer', 'copywriter', 'create-skills', 'designer', 'strategist', 'video-producer'].map((n) => [n, 'builtin']),
    );
    const runtime = join(dir, 'runtime');
    await store.syncToRuntime(runtime);
    expect(existsSync(join(runtime, 'skills', 'video-producer', 'seedance-2_5-prompt-optimizer.md'))).toBe(true);
    expect(existsSync(join(runtime, 'skills', 'audio-producer', 'seed-audio-pe.md'))).toBe(true);
    // 营销技能来自 BuzzVideo Marketing Agent，改写后不能再引用 desktop 没有的工具 / 系统提示块
    const banned = /propose_batch_plan|execute_batch_plan|Locked for this turn|Model Settings|matchModel|videoParams|`list_models`|referenceAudioUrls|referenceImageUrls|referenceVideoUrls/;
    for (const name of ['audio-producer', 'copywriter', 'designer', 'strategist', 'video-producer']) {
      const d = await store.detail(name);
      for (const f of d.files) {
        const text = await readFile(join(resources, name, f), 'utf8');
        expect(banned.exec(text)?.[0], `${name}/${f}`).toBeUndefined();
      }
    }
  });

  it('自定义技能：生成带 frontmatter 的 SKILL.md、附带文件、详情；路径穿越拒绝', async () => {
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
    await store.saveCustom({
      name: 'weekly',
      description: '写周报\n每周五',
      body: '# 步骤',
      files: [{ path: 'references/tpl.md', content: '模板' }],
    });
    const d = await store.detail('weekly');
    expect(d.skillMd).toContain('description: 写周报 每周五');
    expect(d.body).toBe('# 步骤');
    expect(d.files).toEqual(['SKILL.md', 'references/tpl.md']);
    await expect(
      store.saveCustom({ name: 'evil', description: 'x', body: 'y', files: [{ path: '../out.txt', content: 'x' }] }),
    ).rejects.toThrow('路径不合法');
    await expect(store.saveCustom({ name: 'Bad_Name', description: 'x', body: 'y' })).rejects.toBeInstanceOf(
      SkillInstallError,
    );
  });

  it('从文件夹导入时不复制软链（防指向技能目录外）', async () => {
    const src = join(dir, 'src', 'linky');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), '---\nname: linky\ndescription: d\n---\n');
    await writeFile(join(dir, 'secret.txt'), 'top-secret');
    await symlink(join(dir, 'secret.txt'), join(src, 'leak.txt'));
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
    await store.installFromFolder(src);
    expect(existsSync(join(dir, 'lib', 'linky', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'lib', 'linky', 'leak.txt'))).toBe(false);
  });

  it('save_skill 工具：保存成功返回用法，校验失败把原因回给模型', async () => {
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
    let saved = 0;
    const t = createSaveSkillTool(store, () => saved++);
    const ok: unknown = await t.invoke({ name: 'daily-note', description: '记日报', instructions: '写三条' });
    expect(String(ok)).toContain('/daily-note');
    expect(saved).toBe(1);
    expect(await readFile(join(dir, 'lib', 'daily-note', 'SKILL.md'), 'utf8')).toContain('写三条');
    const bad: unknown = await t.invoke({ name: 'Bad Name', description: 'x', instructions: 'y' });
    expect(String(bad)).toContain('保存失败');
  });
});

describe('MCP 连接器', () => {
  it('地址只收 https，http 仅本机', () => {
    expect(validateMcpUrl('https://x.example/mcp#frag')).toBe('https://x.example/mcp');
    expect(validateMcpUrl('http://127.0.0.1:9000/mcp')).toBe('http://127.0.0.1:9000/mcp');
    expect(() => validateMcpUrl('http://evil.example/mcp')).toThrow(McpError);
    expect(() => validateMcpUrl('nope')).toThrow(McpError);
  });

  it('每个连接器一个独立 sandbox 源，且不暴露原始 id', () => {
    const a = sandboxOrigin('server-a');
    expect(a).toMatch(/^spark-mcp:\/\/m-[a-f0-9]{16}$/);
    expect(a).not.toBe(sandboxOrigin('server-b'));
    expect(a).not.toContain('server-a');
  });

  it('列表带推荐连接器；App 上下文按会话存、最多 10 份、按时间先后注入', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const mcp = new McpStore(db, 'http://127.0.0.1:1/cb', () => Promise.resolve());
    expect(mcp.list().presets.map((p) => p.key)).toContain('buzzvideo');
    // 连接一个不存在的本机地址：记为 error，不抛
    const r = await mcp.add('http://127.0.0.1:9/mcp', 'Local');
    expect(r.status).toBe('error');
    const conv = new ConversationRepo(db, () => dir).create(null);
    for (let i = 0; i < 12; i++) mcp.setAppContext(conv.id, `call-${i}`, r.server.id, `ctx-${i}`);
    const ctx = mcp.appContext(conv.id);
    expect(ctx).toHaveLength(10);
    expect(ctx.map((c) => c.text)).not.toContain('ctx-0');
    expect(ctx.at(-1)).toMatchObject({ server: 'Local', text: 'ctx-11' });
  });

  it('App 调工具：快照里没有的工具拒绝', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const mcp = new McpStore(db, 'http://127.0.0.1:1/cb', () => Promise.resolve());
    const r = await mcp.add('http://127.0.0.1:9/mcp');
    expect(() => mcp.callToolFromApp(r.server.id, 'nope', {}, false)).toThrow('工具不存在');
  });
});
