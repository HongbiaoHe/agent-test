import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
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
  const services: Services = {
    repo: new ConversationRepo(db, () => dir),
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
