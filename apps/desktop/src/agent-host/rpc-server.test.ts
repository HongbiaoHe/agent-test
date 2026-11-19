import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
import { emptyProject } from '@agent-test/video-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BackgroundService } from './background/background-service';
import { ConversationRepo } from './db/conversations';
import { openDatabase } from './db/database';
import { McpStore } from './mcp/mcp-store';
import { LlmStore } from './llm/llm-store';
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
  let llmChanged = 0;
  const keys: Record<string, string> = {};
  const llm = new LlmStore(db, (id) => keys[id] ?? null);
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
    config: () => ({ workspaceDir: dir, runtimeRoot: join(dir, 'runtime') }),
    llm,
    keyOf: (id) => keys[id] ?? null,
    llmChanged: () => {
      llmChanged++;
    },
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
  return {
    s: services,
    h: createHandlers(services),
    keys,
    modesChangedCount: () => modesChanged,
    llmChangedCount: () => llmChanged,
  };
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
      description: null,
      subagentModeIds: [],
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
      description: null,
      subagentModeIds: [],
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
    // 账号默认模型：一个启用的连接模型
    const conn = s.llm.createConnection({ name: 'G', protocol: 'gemini', baseUrl: 'https://g.test', presetId: 'gemini' });
    const ref = s.llm.addManualModel(conn.id, 'gemini-3.8-flash').ref;
    s.llm.setDefaultModel(ref);
    const plain = await h['conversations.create']({});
    expect(plain.model).toBe(ref);
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
      description: null,
      subagentModeIds: [],
    });
    // 模式没设默认模型：落到全局默认，不借用通用模式的设置
    const withMode = await h['conversations.create']({ modeId: mode.id });
    expect(withMode).toMatchObject({ model: ref, thinkingLevel: null, modeId: mode.id });
  });
});

describe('API 连接与模型 RPC（llm.*）', () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  afterEach(() => fetchMock.mockReset());
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('建连接 → 拉模型（Key 来自内存表）→ 搜索后勾选启用 → 出现在模型下拉 → 设默认；每步广播 llm-changed', async () => {
    const { h, keys, llmChangedCount } = setup();
    expect((await h['host.status']({})).hasModels).toBe(false);
    const conn = await h['llm.connections.create']({
      name: 'DeepSeek',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      presetId: 'deepseek',
    });
    expect(conn).toMatchObject({ keyRequired: true, keyConfigured: false, modelCount: 0 });
    keys[conn.id] = 'sk-live';
    expect((await h['llm.connections.list']({}))[0].keyConfigured).toBe(true);

    fetchMock.mockImplementation(() => json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
    const models = await h['llm.models.refresh']({ connectionId: conn.id });
    expect(models.map((m) => [m.modelId, m.enabled, m.listState])).toEqual([
      ['deepseek-flash', false, 'listed'],
      ['deepseek-v4-pro', false, 'listed'],
    ]);
    expect(models[0].capabilities.thinkingStyle).toBe('thinking-type');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url instanceof Request ? url.url : url.toString()).toBe('https://api.deepseek.com/models');
    expect(init?.headers).toEqual({ Authorization: 'Bearer sk-live' });

    await h['llm.models.setEnabled']({ connectionId: conn.id, modelIds: ['deepseek-flash'], enabled: true });
    const options = await h['models.list']({});
    expect(options.map((o) => [o.ref, o.connectionName])).toEqual([[`${conn.id}/deepseek-flash`, 'DeepSeek']]);
    const status = await h['llm.defaultModel.set']({ ref: `${conn.id}/deepseek-flash` });
    expect(status).toMatchObject({ defaultModel: `${conn.id}/deepseek-flash`, hasModels: true });
    // 没启用的模型不能设为默认（经 dispatch 调用时是 rejected promise，这里直接调处理函数是同步抛错）
    expect(() => h['llm.defaultModel.set']({ ref: `${conn.id}/deepseek-v4-pro` })).toThrow();
    expect(llmChangedCount()).toBeGreaterThanOrEqual(4);
  });

  it('刷新：新出现的标 new、没拉到的标 missing（不删、不改启用）；手填的不参与下架', async () => {
    const { h } = setup();
    const conn = await h['llm.connections.create']({ name: 'X', protocol: 'openai', baseUrl: 'https://x.test/v1', presetId: 'openai' });
    fetchMock.mockImplementation(() => json({ data: [{ id: 'a' }, { id: 'b' }] }));
    await h['llm.models.refresh']({ connectionId: conn.id });
    await h['llm.models.setEnabled']({ connectionId: conn.id, modelIds: ['a', 'b'], enabled: true });
    await h['llm.models.add']({ connectionId: conn.id, modelId: 'manual-1' });
    fetchMock.mockImplementation(() => json({ data: [{ id: 'b' }, { id: 'c' }] }));
    const after = await h['llm.models.refresh']({ connectionId: conn.id });
    expect(after.map((m) => [m.modelId, m.enabled, m.listState, m.source])).toEqual([
      ['a', true, 'missing', 'listed'],
      ['b', true, 'listed', 'listed'],
      ['c', false, 'new', 'listed'],
      ['manual-1', true, 'listed', 'manual'],
    ]);
  });

  it('测连接：鉴权失败返回原始错误；删连接：模型一起删、默认模型清掉', async () => {
    const { h } = setup();
    const conn = await h['llm.connections.create']({ name: 'X', protocol: 'openai', baseUrl: 'https://x.test/v1', presetId: 'openai' });
    fetchMock.mockImplementation(() => json({ error: { message: 'Incorrect API key' } }, 401));
    const t = await h['llm.connections.test']({ id: conn.id });
    expect(t.ok).toBe(false);
    expect(t.message).toContain('Incorrect API key');
    await h['llm.models.add']({ connectionId: conn.id, modelId: 'gpt-4o' });
    await h['llm.defaultModel.set']({ ref: `${conn.id}/gpt-4o` });
    await h['llm.connections.delete']({ id: conn.id });
    expect(await h['models.list']({})).toEqual([]);
    expect(await h['host.status']({})).toMatchObject({ defaultModel: null, hasModels: false });
  });

  it('改能力：档位按写法收窄、auto 总在；之后刷新不再覆盖', async () => {
    const { h } = setup();
    const conn = await h['llm.connections.create']({ name: 'X', protocol: 'openai-compatible', baseUrl: 'https://x.test/v1', presetId: 'custom' });
    await h['llm.models.add']({ connectionId: conn.id, modelId: 'qwen3' });
    const m = await h['llm.models.updateCapabilities']({
      connectionId: conn.id,
      modelId: 'qwen3',
      capabilities: { thinkingStyle: 'enable-thinking', thinkingLevels: ['on', 'off', 'high'], contextWindow: 131072 },
    });
    expect(m.capabilities).toEqual({ thinkingStyle: 'enable-thinking', thinkingLevels: ['auto', 'on', 'off'], contextWindow: 131072 });
    expect(m.capabilitiesEdited).toBe(true);
    fetchMock.mockImplementation(() => json({ data: [{ id: 'qwen3', context_length: 8000 }] }));
    const after = await h['llm.models.refresh']({ connectionId: conn.id });
    expect(after[0].capabilities.contextWindow).toBe(131072);
  });

  it('测 OpenAI 推理模型：要思考摘要被拒（组织未验证）→ 去掉重测通过，自动关掉摘要；刷新列表后仍关着', async () => {
    const { h, keys } = setup();
    const conn = await h['llm.connections.create']({ name: 'OpenAI', protocol: 'openai', baseUrl: 'https://oai.test/v1', presetId: 'openai' });
    keys[conn.id] = 'sk-test';
    await h['llm.models.add']({ connectionId: conn.id, modelId: 'gpt-5.6' });
    const bodies: unknown[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      bodies.push(body);
      const wantsSummary = z.object({ reasoning: z.object({ summary: z.string() }) }).safeParse(body).success;
      if (wantsSummary) {
        return json({ error: { message: 'Your organization must be verified to generate reasoning summaries.' } }, 400);
      }
      // OpenAI SDK 按 content-type 决定是否解析 JSON
      const ok = {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.6',
        output: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '{"value":"ok"}', status: 'completed' },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      return Promise.resolve(new Response(JSON.stringify(ok), { headers: { 'content-type': 'application/json' } }));
    });
    const m = await h['llm.models.test']({ connectionId: conn.id, modelId: 'gpt-5.6' });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('reasoning');
    expect(m.test).toMatchObject({ status: 'ok' });
    expect(m.test).not.toHaveProperty('reasoningSummaryUnsupported');
    expect(m.capabilities).toMatchObject({ thinkingStyle: 'openai-effort', reasoningSummary: false });
    expect(m.capabilitiesEdited).toBe(false);

    fetchMock.mockImplementation(() => json({ data: [{ id: 'gpt-5.6' }] }));
    const after = await h['llm.models.refresh']({ connectionId: conn.id });
    expect(after[0].capabilities.reasoningSummary).toBe(false);
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
