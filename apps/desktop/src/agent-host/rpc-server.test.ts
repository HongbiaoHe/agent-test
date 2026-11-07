import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
import { emptyProject } from '@agent-test/video-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundService } from './background/background-service';
import { ConversationRepo } from './db/conversations';
import { openDatabase } from './db/database';
import { McpStore } from './mcp/mcp-store';
import { ModeStore } from './modes/mode-store';
import { createHandlers, type Services } from './rpc-server';
import type { RunService } from './run/run-service';
import { buildDesktopRegistry } from './run/tool-registry';
import { SkillStore } from './skills/skill-store';
import { VideoService } from './video/video-service';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-rpc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DEFAULT_MODEL = 'google-genai:gemini-3.8-flash';

function setup() {
  const db = openDatabase(join(dir, 'spark.db'));
  const skills = new SkillStore(db, join(dir, 'lib'));
  let modesChanged = 0;
  const repo = new ConversationRepo(db, () => dir);
  const services: Services = {
    repo,
    // 这些用例不碰运行 / 后台任务：在注入处收窄成真实类型
    runs: {} as unknown as RunService,
    background: {} as unknown as BackgroundService,
    skills,
    mcp: new McpStore(db, 'http://127.0.0.1:1/cb', () => Promise.resolve()),
    modes: new ModeStore(db),
    registry: buildDesktopRegistry({ webApi: null, skills, skillsChanged: () => undefined, background: () => null }),
    config: () => ({
      workspaceDir: dir,
      defaultModel: DEFAULT_MODEL,
      runtimeRoot: join(dir, 'runtime'),
      keys: { google: true, deepseek: false },
    }),
    listChanged: () => undefined,
    mcpChanged: () => undefined,
    skillsChanged: () => undefined,
    modesChanged: () => {
      modesChanged++;
    },
    webApi: null,
    video: new VideoService({
      workspaceOf: (id) => repo.require(id).workspaceDir,
      emit: () => undefined,
      binaries: () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
    }),
  };
  return { s: services, h: createHandlers(services), modesChangedCount: () => modesChanged };
}

describe('通用模式 RPC', () => {
  it('get：没存过 = 默认提示词、未自定义；update 后生效并广播 modes-changed；null 恢复默认', async () => {
    const { h, modesChangedCount } = setup();
    expect(await h['modes.general.get']({})).toEqual({
      systemPrompt: GENERAL_MODE_PROMPT,
      isCustom: false,
      defaultPrompt: GENERAL_MODE_PROMPT,
      defaultModel: null,
      defaultThinkingLevel: null,
    });

    const updated = await h['modes.general.update']({
      systemPrompt: '自定义通用。',
      defaultModel: DEFAULT_MODEL,
      defaultThinkingLevel: 'low',
    });
    expect(updated).toMatchObject({ systemPrompt: '自定义通用。', isCustom: true, defaultPrompt: GENERAL_MODE_PROMPT });
    expect(modesChangedCount()).toBe(1);
    // 目录里的通用提示词（「从通用复制」用）也跟着变成生效的
    expect((await h['modes.catalog']({})).generalPrompt).toBe('自定义通用。');

    const reset = await h['modes.general.update']({ systemPrompt: null, defaultModel: null, defaultThinkingLevel: null });
    expect(reset).toMatchObject({ systemPrompt: GENERAL_MODE_PROMPT, isCustom: false });
  });

  it('preview：null 用默认提示词，传了就用传的；工具 / 技能仍是全集', async () => {
    const { h } = setup();
    const def = await h['modes.general.preview']({ systemPrompt: null });
    expect(def.systemPrompt.startsWith('你是 Spark')).toBe(true);
    const custom = await h['modes.general.preview']({ systemPrompt: 'GENERAL-PREVIEW\n\n{{platform.language}}' });
    expect(custom.systemPrompt.startsWith('GENERAL-PREVIEW\n\n')).toBe(true);
    expect(custom.systemPrompt).not.toContain('{{platform.language}}');
    // 全集装配：没登录 Web 时媒体工具因缺 media_api 进不可用清单（与通用模式运行口径一致）
    expect(custom.unavailable.map((u) => u.name)).toContain('generate_image');
  });

  it('平台片段：list / update 广播 modes-changed；通用与模式预览都用改写后的正文，{{skills_dir}} 已替换', async () => {
    const { h, modesChangedCount } = setup();
    const before = await h['modes.fragments.list']({});
    expect(before.map((f) => [f.id, f.isCustom])).toEqual([
      ['platform.language', false],
      ['platform.slash_command', false],
      ['platform.skill_loading', false],
      ['platform.injection_guard', false],
    ]);

    const text = '## 回复语言\nFRAG-RPC 技能目录：{{skills_dir}}';
    const updated = await h['modes.fragments.update']({ id: 'platform.language', text });
    expect(updated).toMatchObject({ id: 'platform.language', text, isCustom: true });
    expect(modesChangedCount()).toBe(1);
    expect((await h['modes.fragments.list']({})).find((f) => f.id === 'platform.language')?.isCustom).toBe(true);

    const general = await h['modes.general.preview']({ systemPrompt: null });
    expect(general.systemPrompt).toContain('FRAG-RPC 技能目录：<runtime>/skills');
    expect(general.systemPrompt).not.toContain('{{skills_dir}}');
    expect(general.systemPrompt).not.toContain(before[0].defaultText);

    const mode = await h['modes.preview']({
      name: 'p',
      systemPrompt: 'MODE\n\n{{platform.language}}',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    });
    expect(mode.systemPrompt.startsWith('MODE\n\n## 回复语言\nFRAG-RPC 技能目录：<runtime>/skills')).toBe(true);

    // 恢复默认后预览回到默认正文
    await h['modes.fragments.update']({ id: 'platform.language', text: null });
    expect(modesChangedCount()).toBe(2);
    expect((await h['modes.general.preview']({ systemPrompt: null })).systemPrompt).toContain(before[0].defaultText);
  });

  it('自建片段：create / update / delete 广播 modes-changed；目录追加自建 id；通用与模式预览都展开自建片段', async () => {
    const { h, modesChangedCount } = setup();
    const created = await h['modes.fragments.create']({
      id: 'custom.marker',
      title: '标记',
      text: 'CUSTOM-RPC 技能目录：{{skills_dir}}',
    });
    expect(created).toMatchObject({ kind: 'custom', id: 'custom.marker', title: '标记', defaultText: null });
    expect(modesChangedCount()).toBe(1);
    expect((await h['modes.fragments.list']({})).map((f) => f.id).slice(-1)).toEqual(['custom.marker']);
    expect((await h['modes.catalog']({})).fragments).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
      'custom.marker',
    ]);

    const modeInput = {
      name: 'p',
      systemPrompt: 'MODE\n\n{{custom.marker}}',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    const mode = await h['modes.preview'](modeInput);
    expect(mode.systemPrompt.startsWith('MODE\n\nCUSTOM-RPC 技能目录：<runtime>/skills')).toBe(true);
    const general = await h['modes.general.preview']({ systemPrompt: 'G\n{{custom.marker}}' });
    expect(general.systemPrompt.startsWith('G\nCUSTOM-RPC 技能目录：<runtime>/skills')).toBe(true);
    expect(general.systemPrompt).not.toContain('{{custom.marker}}');

    // 改正文后预览跟着变
    await h['modes.fragments.update']({ id: 'custom.marker', text: 'CUSTOM-RPC-2' });
    expect(modesChangedCount()).toBe(2);
    expect((await h['modes.preview'](modeInput)).systemPrompt.startsWith('MODE\n\nCUSTOM-RPC-2')).toBe(true);

    // 被模式引用时删除被拒（不广播）；删掉模式后可删，目录里也没了
    const saved = await h['modes.create'](modeInput);
    expect(() => h['modes.fragments.delete']({ id: 'custom.marker' })).toThrow('模式「p」');
    expect(modesChangedCount()).toBe(3);
    await h['modes.delete']({ id: saved.id });
    expect(await h['modes.fragments.delete']({ id: 'custom.marker' })).toEqual({ ok: true });
    expect(modesChangedCount()).toBe(5);
    expect((await h['modes.catalog']({})).fragments).not.toContain('custom.marker');
  });

  it('新建会话：没带模式时用通用设置的默认模型 / 思考档位回填；模式优先；带了 model 以带的为准', async () => {
    const { s, h } = setup();
    const plain = await h['conversations.create']({});
    expect(plain.model).toBe(DEFAULT_MODEL);
    expect(plain.thinkingLevel).toBeNull();

    s.modes.updateGeneral({ systemPrompt: null, defaultModel: 'deepseek:deepseek-chat', defaultThinkingLevel: 'high' });
    const general = await h['conversations.create']({});
    expect(general).toMatchObject({ model: 'deepseek:deepseek-chat', thinkingLevel: 'high', modeId: null });
    // 模式已被删：按通用建，也用通用默认值
    const orphan = await h['conversations.create']({ modeId: 'gone' });
    expect(orphan).toMatchObject({ model: 'deepseek:deepseek-chat', modeId: null });
    const explicit = await h['conversations.create']({ model: DEFAULT_MODEL });
    expect(explicit.model).toBe(DEFAULT_MODEL);

    const mode = s.modes.create({
      name: 'm',
      systemPrompt: 'x',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    });
    // 模式没设默认模型：落到全局默认，不借用通用模式的设置
    const withMode = await h['conversations.create']({ modeId: mode.id });
    expect(withMode).toMatchObject({ model: DEFAULT_MODEL, thinkingLevel: null, modeId: mode.id });
  });
});

describe('剪辑器 RPC（video.*）', () => {
  const project = () => ({
    ...emptyProject('rpc', { width: 640, height: 360 }),
    video: [{ id: 'v1', type: 'image' as const, src: 'media/a.png', duration: 2, width: 640, height: 360 }],
  });

  it('write：不合法抛出带 issues 的错误；baseMtimeMs 与磁盘不一致 → conflict 且不写；省略 baseMtimeMs = 强制覆盖', async () => {
    const { h, s } = setup();
    const c = await h['conversations.create']({});
    const path = 'videos/rpc.sparkvideo.json';
    await expect(
      h['video.write']({ conversationId: c.id, path, project: { ...project(), canvas: { width: 0, height: 1 } } }),
    ).rejects.toThrow(/canvas\.width/);

    const first = await h['video.write']({ conversationId: c.id, path, project: project() });
    if (!first.ok) throw new Error('首次写入应成功');
    const read = await h['video.read']({ conversationId: c.id, path });
    expect(read).toMatchObject({ path, issues: [], mtimeMs: first.mtimeMs });
    expect(read.project?.name).toBe('rpc');

    // 外部（agent）改了文件 → 编辑器拿旧 mtime 写回得到 conflict，磁盘内容不变
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, path), JSON.stringify({ ...project(), name: 'agent 改的' }));
    const conflict = await h['video.write']({ conversationId: c.id, path, project: { ...project(), name: '我的' }, baseMtimeMs: first.mtimeMs });
    expect(conflict).toMatchObject({ ok: false, conflict: true });
    expect(JSON.parse(await readFile(join(dir, path), 'utf8'))).toMatchObject({ name: 'agent 改的' });

    const forced = await h['video.write']({ conversationId: c.id, path, project: { ...project(), name: '我的' } });
    expect(forced.ok).toBe(true);
    expect(JSON.parse(await readFile(join(dir, path), 'utf8'))).toMatchObject({ name: '我的' });
    expect(await h['video.list']({ conversationId: c.id })).toEqual([
      { path, name: '我的', duration: 2, mtimeMs: forced.mtimeMs },
    ]);
    s.video.dispose();
  });

  it('read：JSON 损坏 / schema 不过 → project 为 null + issues（不抛）', async () => {
    const { h, s } = setup();
    const c = await h['conversations.create']({});
    await mkdir(join(dir, 'videos'), { recursive: true });
    await writeFile(join(dir, 'videos/broken.sparkvideo.json'), '{ not json');
    await writeFile(join(dir, 'videos/invalid.sparkvideo.json'), JSON.stringify({ version: 1, name: 'x' }));
    const broken = await h['video.read']({ conversationId: c.id, path: 'videos/broken.sparkvideo.json' });
    expect(broken.project).toBeNull();
    expect(broken.issues[0]).toMatch(/^JSON/);
    const invalid = await h['video.read']({ conversationId: c.id, path: 'videos/invalid.sparkvideo.json' });
    expect(invalid.project).toBeNull();
    expect(invalid.issues.some((i) => i.startsWith('canvas'))).toBe(true);
    // 列表里照样出现，duration 为 null
    const list = await h['video.list']({ conversationId: c.id });
    expect(list.map((x) => [x.path, x.duration]).sort()).toEqual([
      ['videos/broken.sparkvideo.json', null],
      ['videos/invalid.sparkvideo.json', null],
    ]);
    s.video.dispose();
  });

  it('路径逃逸被拒：.. 出域、软链出域、绝对路径；非工程后缀也拒', async () => {
    const { h } = setup();
    const c = await h['conversations.create']({});
    const outside = await mkdtemp(join(tmpdir(), 'spark-rpc-outside-'));
    try {
      await symlink(outside, join(dir, 'link'));
      for (const path of ['../evil.sparkvideo.json', 'link/evil.sparkvideo.json', `${outside}/evil.sparkvideo.json`]) {
        await expect(h['video.write']({ conversationId: c.id, path, project: project() })).rejects.toThrow(/不在工作区内/);
      }
      await writeFile(join(outside, 'x.sparkvideo.json'), JSON.stringify(project()));
      await expect(h['video.read']({ conversationId: c.id, path: 'link/x.sparkvideo.json' })).rejects.toThrow(/不在工作区内/);
      await expect(h['video.read']({ conversationId: c.id, path: '../x.sparkvideo.json' })).rejects.toThrow(/不在工作区内/);
      await expect(h['video.probe']({ conversationId: c.id, paths: ['../../etc/hosts'] })).rejects.toThrow(/不在工作区内/);
      await expect(h['video.probe']({ conversationId: c.id, paths: ['link/x.sparkvideo.json'] })).rejects.toThrow(/不在工作区内/);
      await expect(h['video.write']({ conversationId: c.id, path: 'a.json', project: project() })).rejects.toThrow(/sparkvideo/);
      // 软链指向工作区外：列表不跟随
      expect(await h['video.list']({ conversationId: c.id })).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
