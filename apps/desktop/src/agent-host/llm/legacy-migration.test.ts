import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../db/conversations';
import { openDatabase } from '../db/database';
import { ModeStore } from '../modes/mode-store';
import { migrateLegacyModels } from './legacy-migration';
import { LlmStore } from './llm-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-llm-legacy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(join(dir, 'spark.db'));
  return {
    db,
    llm: new LlmStore(db, () => 'k'),
    repo: new ConversationRepo(db, () => dir),
    modes: new ModeStore(db),
  };
}

const modeInput = (defaultModel: string | null) => ({
  name: `m-${defaultModel}`,
  systemPrompt: 'x',
  toolNames: [],
  mcpServerIds: [],
  skillNames: [],
  defaultModel,
  defaultThinkingLevel: null,
  description: null,
  subagentModeIds: [],
});

describe('migrateLegacyModels', () => {
  it('建好 Gemini / DeepSeek 连接并启用原来的模型；会话 / 模式 / 通用模式 / 默认模型的旧名改写成新引用；只跑一次', () => {
    const { db, llm, repo, modes } = setup();
    const c1 = repo.create('google-genai:gemini-3.8-flash');
    const c2 = repo.create('deepseek:deepseek-flash');
    const c3 = repo.create('gemini-3.6-flash'); // 旧 DB 里的裸名
    const c4 = repo.create('openai:gpt-4o'); // 对不上
    const m = modes.create(modeInput('deepseek:deepseek-v4-pro'));
    modes.updateGeneral({ systemPrompt: null, defaultModel: 'google-genai:gemini-4-argon', defaultThinkingLevel: null });

    const done = migrateLegacyModels(db, llm, {
      connections: [
        { id: 'conn-g', presetId: 'gemini' },
        { id: 'conn-d', presetId: 'deepseek' },
      ],
      legacyDefaultModel: 'deepseek:deepseek-flash',
    });
    expect(done).toBe(true);

    expect(llm.listConnections().map((c) => [c.id, c.name, c.protocol, c.enabledCount])).toEqual([
      ['conn-g', 'Google Gemini', 'gemini', 7],
      ['conn-d', 'DeepSeek', 'openai-compatible', 2],
    ]);
    expect(repo.require(c1.id).model).toBe('conn-g/gemini-3.8-flash');
    expect(repo.require(c2.id).model).toBe('conn-d/deepseek-flash');
    expect(repo.require(c3.id).model).toBe('conn-g/gemini-3.6-flash');
    expect(repo.require(c4.id).model).toBeNull();
    expect(modes.get(m.id)?.defaultModel).toBe('conn-d/deepseek-v4-pro');
    expect(modes.getGeneral().defaultModel).toBe('conn-g/gemini-4-argon');
    expect(llm.defaultModel()).toBe('conn-d/deepseek-flash');

    // 第二次（每次 config 都会带上同一份列表）不再动任何东西
    llm.setEnabled('conn-g', ['gemini-3.8-flash'], false);
    expect(
      migrateLegacyModels(db, llm, {
        connections: [{ id: 'conn-g', presetId: 'gemini' }],
        legacyDefaultModel: null,
      }),
    ).toBe(false);
    expect(llm.listConnections()[0].enabledCount).toBe(6);
  });

  it('设备上没有旧 Key（新用户）：不建连接，旧模型名一律置空（按账号默认模型跑）', () => {
    const { db, llm, repo } = setup();
    const c = repo.create('google-genai:gemini-3.8-flash');
    expect(migrateLegacyModels(db, llm, { connections: [], legacyDefaultModel: 'google-genai:gemini-3.8-flash' })).toBe(true);
    expect(llm.listConnections()).toEqual([]);
    expect(repo.require(c.id).model).toBeNull();
    expect(llm.defaultModel()).toBeNull();
  });

  it('只有 Gemini 的旧 Key：DeepSeek 的旧模型名对不上、置空；已是新格式的引用原样保留', () => {
    const { db, llm, repo } = setup();
    const ds = repo.create('deepseek:deepseek-flash');
    migrateLegacyModels(db, llm, { connections: [{ id: 'g', presetId: 'gemini' }], legacyDefaultModel: null });
    expect(repo.require(ds.id).model).toBeNull();
    // 新格式引用：已有连接下启用的模型
    expect(llm.effectiveRef('g/gemini-3.8-flash')).toBe('g/gemini-3.8-flash');
    // 没有默认模型时按第一个启用的模型
    expect(llm.effectiveRef(null)).toBe('g/gemini-3-flash-preview');
  });
});
