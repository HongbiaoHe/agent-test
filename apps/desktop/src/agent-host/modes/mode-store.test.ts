import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_FRAGMENT_DEFAULTS, PROMPT_FRAGMENT_IDS } from '@agent-test/agent-core/modes/prompt-fragments';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../db/conversations';
import { openDatabase } from '../db/database';
import { ModeStore } from './mode-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-modes-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = {
  name: ' 生图 ',
  systemPrompt: '你是生图助手。\n\n{{platform.language}}',
  toolNames: ['generate_image', 'list_media_models'],
  mcpServerIds: ['srv-1'],
  skillNames: ['tvc-director'],
  defaultModel: 'google-genai:gemini-3.8-flash',
  defaultThinkingLevel: null,
};

describe('ModeStore', () => {
  it('create → list → update → remove；JSON 列往返、名字 trim、按名排序', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    const a = store.create(input);
    expect(a.id).toMatch(/[0-9a-f-]{36}/);
    expect(a.name).toBe('生图');
    expect(a.toolNames).toEqual(['generate_image', 'list_media_models']);
    expect(a.mcpServerIds).toEqual(['srv-1']);
    expect(a.skillNames).toEqual(['tvc-director']);
    expect(a.defaultModel).toBe('google-genai:gemini-3.8-flash');
    expect(a.defaultThinkingLevel).toBeNull();

    const b = store.create({ ...input, name: 'Alpha', toolNames: [] });
    expect(store.list().map((m) => m.name)).toEqual(['Alpha', '生图']);

    const updated = store.update(a.id, { ...input, name: '生图 v2', skillNames: [] });
    expect(updated.name).toBe('生图 v2');
    expect(updated.skillNames).toEqual([]);
    expect(store.get(a.id)?.name).toBe('生图 v2');

    store.remove(b.id);
    expect(store.get(b.id)).toBeNull();
    expect(store.list().map((m) => m.id)).toEqual([a.id]);
    expect(() => store.require(b.id)).toThrow('模式不存在');
  });

  it('删模式：引用它的会话 modeId 置空，其它会话不受影响', () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const store = new ModeStore(db);
    const repo = new ConversationRepo(db, () => dir);
    const mode = store.create(input);
    const other = store.create({ ...input, name: 'other' });
    const c1 = repo.create(null, {}, mode.id);
    const c2 = repo.create(null, {}, other.id);
    const c3 = repo.create(null);
    expect(c1.modeId).toBe(mode.id);
    expect(c3.modeId).toBeNull();

    expect(store.remove(mode.id)).toBe(1);
    expect(repo.require(c1.id).modeId).toBeNull();
    expect(repo.require(c2.id).modeId).toBe(other.id);
  });

  it('未知占位符：create / update 都拒绝', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    const bad = { ...input, systemPrompt: '{{platform.language}} {{platform.nope}} {{custom.x}}' };
    expect(() => store.create(bad)).toThrow('platform.nope, custom.x');
    const ok = store.create(input);
    expect(() => store.update(ok.id, bad)).toThrow('platform.nope');
    expect(store.get(ok.id)?.systemPrompt).toBe(input.systemPrompt);
  });

  it('通用模式设置：无行全默认；update 整份覆盖；恢复默认存 null；重开库仍在', () => {
    const file = join(dir, 'spark.db');
    const store = new ModeStore(openDatabase(file));
    expect(store.getGeneral()).toEqual({ systemPrompt: null, defaultModel: null, defaultThinkingLevel: null });

    const custom = {
      systemPrompt: '你是我的助手。\n\n{{platform.language}}',
      defaultModel: 'google-genai:gemini-3.8-flash',
      defaultThinkingLevel: 'low',
    };
    expect(store.updateGeneral(custom)).toEqual(custom);
    expect(new ModeStore(openDatabase(file)).getGeneral()).toEqual(custom);

    // 恢复默认：提示词置 null，默认模型照传的值存
    expect(store.updateGeneral({ ...custom, systemPrompt: null })).toEqual({ ...custom, systemPrompt: null });
    expect(store.updateGeneral({ systemPrompt: null, defaultModel: null, defaultThinkingLevel: null })).toEqual({
      systemPrompt: null,
      defaultModel: null,
      defaultThinkingLevel: null,
    });
  });

  it('通用模式设置：未知占位符拒绝且不落库', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    const ok = { systemPrompt: '{{platform.language}}', defaultModel: null, defaultThinkingLevel: null };
    store.updateGeneral(ok);
    expect(() => store.updateGeneral({ ...ok, systemPrompt: '{{platform.language}} {{platform.nope}}' })).toThrow(
      'platform.nope',
    );
    expect(store.getGeneral().systemPrompt).toBe('{{platform.language}}');
  });

  it('平台片段：没改写时按固定顺序列出 4 个默认正文；overrides 为空', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    const list = store.listFragments();
    expect(list.map((f) => f.id)).toEqual([...PROMPT_FRAGMENT_IDS]);
    for (const f of list) {
      if (f.kind !== 'builtin') throw new Error(`unexpected custom fragment ${f.id}`);
      expect(f.title).toBeNull();
      expect(f.text).toBe(PROMPT_FRAGMENT_DEFAULTS[f.id]);
      expect(f.defaultText).toBe(PROMPT_FRAGMENT_DEFAULTS[f.id]);
      expect(f.isCustom).toBe(false);
    }
    expect(store.fragmentOverrides()).toEqual({});
  });

  it('平台片段：改写生效并落库（重开库仍在），其它片段不受影响', () => {
    const file = join(dir, 'spark.db');
    const store = new ModeStore(openDatabase(file));
    const text = '## 回复语言\n只用英文回复。技能在 {{skills_dir}}。';
    expect(store.updateFragment('platform.language', { text })).toEqual({
      kind: 'builtin',
      id: 'platform.language',
      title: null,
      text,
      defaultText: PROMPT_FRAGMENT_DEFAULTS['platform.language'],
      isCustom: true,
    });
    expect(store.fragmentOverrides()).toEqual({ 'platform.language': text });
    // 再改一次走 upsert
    expect(store.updateFragment('platform.language', { text: `${text}!` }).text).toBe(`${text}!`);
    const reopened = new ModeStore(openDatabase(file));
    expect(reopened.fragmentOverrides()).toEqual({ 'platform.language': `${text}!` });
    expect(reopened.listFragments().filter((f) => f.isCustom).map((f) => f.id)).toEqual(['platform.language']);
  });

  it('平台片段：传 null 或与默认相同的正文都按恢复默认处理（删行）', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    store.updateFragment('platform.language', { text: '改写 A' });
    store.updateFragment('platform.injection_guard', { text: '改写 B' });

    const reset = store.updateFragment('platform.language', { text: null });
    expect(reset).toMatchObject({ text: PROMPT_FRAGMENT_DEFAULTS['platform.language'], isCustom: false });
    expect(store.fragmentOverrides()).toEqual({ 'platform.injection_guard': '改写 B' });

    const same = store.updateFragment('platform.injection_guard', {
      text: PROMPT_FRAGMENT_DEFAULTS['platform.injection_guard'],
    });
    expect(same.isCustom).toBe(false);
    expect(store.fragmentOverrides()).toEqual({});
  });

  it('平台片段：{{skills_dir}} 以外的变量（含引用别的片段）被拒且不落库', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    store.updateFragment('platform.language', { text: '旧正文 {{skills_dir}}' });
    expect(() => store.updateFragment('platform.language', { text: '{{skills_dir}} {{foo}} {{platform.slash_command}}' })).toThrow(
      '片段里只能使用 {{skills_dir}}，不支持：{{foo}}, {{platform.slash_command}}',
    );
    expect(store.fragmentOverrides()).toEqual({ 'platform.language': '旧正文 {{skills_dir}}' });
  });

  it('平台片段：未知 id 拒绝（update 不会新增片段）；正文为空或超长拒绝', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    expect(() => store.updateFragment('platform.nope', { text: '正文' })).toThrow('片段不存在：platform.nope');
    expect(() => store.updateFragment('custom.x', { text: null })).toThrow('片段不存在：custom.x');
    expect(() => store.updateFragment('platform.language', { text: '' })).toThrow('片段正文不能为空');
    expect(() => store.updateFragment('platform.language', { text: 'x'.repeat(20_001) })).toThrow('20000');
    expect(store.fragmentOverrides()).toEqual({});
  });

  it('自建片段：新建后排在内置片段之后（按 id），customFragments 给出正文；重开库仍在', () => {
    const file = join(dir, 'spark.db');
    const store = new ModeStore(openDatabase(file));
    const created = store.createFragment({ id: 'custom.tone_2', title: ' 品牌语气 ', text: '语气要克制。技能在 {{skills_dir}}。' });
    expect(created).toEqual({
      kind: 'custom',
      id: 'custom.tone_2',
      title: '品牌语气',
      text: '语气要克制。技能在 {{skills_dir}}。',
      defaultText: null,
      isCustom: false,
    });
    store.createFragment({ id: 'custom.a', title: 'A', text: '正文 A' });
    expect(store.listFragments().map((f) => f.id)).toEqual([...PROMPT_FRAGMENT_IDS, 'custom.a', 'custom.tone_2']);
    expect(store.customFragments()).toEqual({ 'custom.a': '正文 A', 'custom.tone_2': '语气要克制。技能在 {{skills_dir}}。' });
    // 自建片段不算「改写内置」
    expect(store.fragmentOverrides()).toEqual({});
    expect(new ModeStore(openDatabase(file)).customFragments()).toEqual(store.customFragments());
  });

  it('自建片段：非法 id、重复 id、非法变量 / 引用片段、空显示名都被拒且不落库', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    for (const id of ['tone', 'custom.', 'custom.Tone', 'custom.tone-x', 'custom.a.b', `custom.${'a'.repeat(49)}`, 'platform.language']) {
      expect(() => store.createFragment({ id, title: 't', text: '正文' }), id).toThrow(`片段 id 格式不对：${id}`);
    }
    store.createFragment({ id: 'custom.tone', title: 't', text: '正文' });
    expect(() => store.createFragment({ id: 'custom.tone', title: 't2', text: '正文 2' })).toThrow('片段已存在：custom.tone');
    expect(() => store.createFragment({ id: 'custom.x', title: 't', text: '{{custom.tone}} {{foo}}' })).toThrow(
      '片段里只能使用 {{skills_dir}}，不支持：{{custom.tone}}, {{foo}}',
    );
    expect(() => store.createFragment({ id: 'custom.x', title: '  ', text: '正文' })).toThrow('片段显示名不能为空');
    expect(() => store.createFragment({ id: 'custom.x', title: 't', text: '' })).toThrow('片段正文不能为空');
    expect(store.customFragments()).toEqual({ 'custom.tone': '正文' });
  });

  it('自建片段：可单独改 title / text；text 为 null 报错；内置片段不能改 title', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    store.createFragment({ id: 'custom.tone', title: '旧名', text: '旧正文' });
    expect(store.updateFragment('custom.tone', { title: ' 新名 ' })).toMatchObject({ title: '新名', text: '旧正文' });
    expect(store.updateFragment('custom.tone', { text: '新正文 {{skills_dir}}' })).toMatchObject({
      kind: 'custom',
      title: '新名',
      text: '新正文 {{skills_dir}}',
    });
    expect(() => store.updateFragment('custom.tone', { text: null })).toThrow('没有默认正文');
    expect(() => store.updateFragment('custom.tone', { text: '{{platform.language}}' })).toThrow('不支持：{{platform.language}}');
    expect(() => store.updateFragment('custom.tone', { title: '' })).toThrow('片段显示名不能为空');
    expect(() => store.updateFragment('custom.nope', { text: 'x' })).toThrow('片段不存在：custom.nope');
    expect(store.customFragments()).toEqual({ 'custom.tone': '新正文 {{skills_dir}}' });
    expect(() => store.updateFragment('platform.language', { title: 'x' })).toThrow('内置片段 platform.language 没有显示名');
  });

  it('自建片段：模式 / 通用提示词可以引用已有的自建片段；引用不存在的被拒', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    const ref = { ...input, systemPrompt: '你是助手。\n{{custom.tone}}\n{{platform.language}}' };
    expect(() => store.create(ref)).toThrow('未知的占位符：custom.tone');
    const general = { systemPrompt: '{{custom.tone}}', defaultModel: null, defaultThinkingLevel: null };
    expect(() => store.updateGeneral(general)).toThrow('custom.tone');

    store.createFragment({ id: 'custom.tone', title: '语气', text: '克制' });
    expect(store.create(ref).systemPrompt).toBe(ref.systemPrompt);
    expect(store.updateGeneral(general).systemPrompt).toBe('{{custom.tone}}');
    expect(() => store.create({ ...ref, systemPrompt: '{{custom.tone}} {{custom.other}}' })).toThrow(
      '未知的占位符：custom.other',
    );
  });

  it('自建片段删除：被模式 / 自定义通用提示词引用时拒绝并列出引用处；去掉引用后可删；内置不可删', () => {
    const store = new ModeStore(openDatabase(join(dir, 'spark.db')));
    store.createFragment({ id: 'custom.tone', title: '语气', text: '克制' });
    store.createFragment({ id: 'custom.tone2', title: '语气 2', text: '热情' });
    const a = store.create({ ...input, name: '模式 A', systemPrompt: '{{ custom.tone }}' });
    store.create({ ...input, name: '模式 B', systemPrompt: '{{custom.tone2}}' });
    store.updateGeneral({ systemPrompt: '{{custom.tone}}', defaultModel: null, defaultThinkingLevel: null });

    expect(() => store.deleteFragment('custom.tone')).toThrow('片段 custom.tone 仍被引用，不能删除：模式「模式 A」、通用模式');
    // 只被模式引用
    store.updateGeneral({ systemPrompt: null, defaultModel: null, defaultThinkingLevel: null });
    expect(() => store.deleteFragment('custom.tone')).toThrow(/不能删除：模式「模式 A」$/);
    // 只被通用提示词引用
    store.update(a.id, { ...input, name: '模式 A', systemPrompt: '无引用' });
    store.updateGeneral({ systemPrompt: '前缀 {{custom.tone}}', defaultModel: null, defaultThinkingLevel: null });
    expect(() => store.deleteFragment('custom.tone')).toThrow(/不能删除：通用模式$/);
    expect(store.customFragments()).toHaveProperty('custom.tone');

    store.updateGeneral({ systemPrompt: null, defaultModel: null, defaultThinkingLevel: null });
    store.deleteFragment('custom.tone');
    expect(store.customFragments()).toEqual({ 'custom.tone2': '热情' });
    expect(() => store.deleteFragment('custom.tone')).toThrow('片段不存在：custom.tone');

    expect(() => store.deleteFragment('platform.language')).toThrow('内置片段 platform.language 不能删除');
    expect(() => store.deleteFragment('platform.nope')).toThrow('片段不存在：platform.nope');
  });

  it('会话切模式：空闲可切；运行中 / 等审批拒绝', () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const store = new ModeStore(db);
    const repo = new ConversationRepo(db, () => dir);
    const mode = store.create(input);
    const c = repo.create(null);
    expect(repo.setMode(c.id, mode.id).modeId).toBe(mode.id);
    expect(repo.setMode(c.id, null).modeId).toBeNull();
    repo.setStatus(c.id, 'running');
    expect(() => repo.setMode(c.id, mode.id)).toThrow('运行');
    repo.setStatus(c.id, 'waiting_approval');
    expect(() => repo.setMode(c.id, mode.id)).toThrow('运行');
    repo.setStatus(c.id, 'done');
    expect(repo.setMode(c.id, mode.id).modeId).toBe(mode.id);
  });
});
