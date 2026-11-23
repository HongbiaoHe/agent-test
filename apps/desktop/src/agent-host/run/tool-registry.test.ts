import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_GENERATION_PROMPT } from '@agent-test/agent-core/media/media-prompt';
import { resolveMode } from '@agent-test/agent-core/modes/resolve-mode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database';
import { SkillStore } from '../skills/skill-store';
import { VIDEO_REVIEW_PROMPT } from '../video/review-tool';
import { VIDEO_PROJECT_PROMPT } from '../video/video-tools';
import { buildDesktopRegistry, desktopCapabilities } from './tool-registry';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-registry-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function registry(webApi: null = null) {
  const skills = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
  return buildDesktopRegistry({ webApi, background: () => null, skills, skillsChanged: () => undefined });
}

const MEDIA = ['list_media_models', 'generate_image', 'generate_video', 'generate_audio', 'clone_voice'];
const BACKGROUND = ['watch_until', 'run_in_background', 'schedule_wakeup', 'cancel_background_task'];
const VIDEO = ['create_video_project', 'check_video_project', 'review_video_project'];
const CANVAS = [
  'add_node',
  'add_nodes',
  'update_node',
  'update_nodes',
  'connect_nodes',
  'delete_node',
  'clear_canvas',
  'set_node_model',
  'generate_media_node',
  'merge_video_node',
  'set_clip_order',
];
const CANVAS_BINDING = ['list_canvases', 'open_canvas', 'create_canvas'];

describe('desktop 工具注册表', () => {
  it('登记全部描述符（含没登录时的媒体工具）；目录可序列化、requires 齐全', () => {
    const reg = registry();
    expect(reg.catalog().map((t) => t.name)).toEqual([
      'save_skill',
      ...MEDIA,
      'sync_media_to_sandbox',
      ...CANVAS,
      'inspect_node_media',
      ...CANVAS_BINDING,
      ...BACKGROUND,
      'preview_page',
      ...VIDEO,
    ]);
    const byName = Object.fromEntries(reg.catalog().map((t) => [t.name, t.requires]));
    expect(byName.save_skill).toEqual([]);
    expect(byName.generate_image).toEqual(['media_api']);
    expect(byName.sync_media_to_sandbox).toEqual(['media_api', 'workspace_write']);
    expect(byName.run_in_background).toEqual(['background', 'workspace_write']);
    expect(byName.watch_until).toEqual(['background']);
    expect(byName.preview_page).toEqual(['workspace']);
    expect(byName.create_video_project).toEqual(['workspace_write']);
    expect(byName.check_video_project).toEqual(['workspace']);
    // 审片写 <名字>.review.json；没登录也挂上（返回 not_logged_in 让 agent 提示用户登录）
    expect(byName.review_video_project).toEqual(['workspace_write']);
    // 画布在 Web 账号下：看要 canvas，改要 canvas_write（只读档位没有）
    for (const name of CANVAS) expect(byName[name]).toEqual(['canvas', 'canvas_write']);
    // 看产物是只读的：只读档位也能用
    expect(byName.inspect_node_media).toEqual(['canvas']);
    expect(byName.list_canvases).toEqual(['canvas']);
    expect(byName.open_canvas).toEqual(['canvas']);
    expect(byName.create_canvas).toEqual(['canvas', 'canvas_write']);
    expect(reg.get('create_video_project')?.promptSection).toBe(VIDEO_PROJECT_PROMPT);
    expect(reg.get('check_video_project')?.promptSection).toBe(VIDEO_PROJECT_PROMPT);
    expect(reg.get('review_video_project')?.promptSection).toBe(VIDEO_REVIEW_PROMPT);
    expect(reg.get('save_skill')?.interruptOn).toBe(true);
    for (const name of MEDIA) expect(reg.get(name)?.promptSection).toBe(MEDIA_GENERATION_PROMPT);
  });

  it('能力集：read_only 没有 workspace_write；没登录没有 media_api；没后台服务没有 background', () => {
    expect([...desktopCapabilities({ permission: 'ask', webApi: null, background: null })]).toEqual(['workspace', 'workspace_write']);
    expect([...desktopCapabilities({ permission: 'read_only', webApi: null, background: null })]).toEqual(['workspace']);
  });

  it('没登录 Web 账号：通用模式下媒体工具被 resolveMode 列进 unavailable，媒体提示段不出现', () => {
    const reg = registry();
    const env = {
      capabilities: desktopCapabilities({ permission: 'ask', webApi: null, background: null }),
      workspace: join(dir, 'ws'),
      skillsDir: join(dir, 'runtime', 'skills'),
    };
    const a = resolveMode({ mode: null, registry: reg, env, installedSkills: [], mcpServers: [] });
    // 通用模式自动带上剪辑工具（不依赖 Web 登录）；工程格式说明段只拼一次
    expect(a.toolDescriptors.map((t) => t.name)).toEqual(['save_skill', 'preview_page', ...VIDEO]);
    expect(a.systemPrompt.split(VIDEO_PROJECT_PROMPT)).toHaveLength(2);
    expect(a.unavailable.map((u) => u.name).sort()).toEqual(
      [...MEDIA, 'sync_media_to_sandbox', ...CANVAS, 'inspect_node_media', ...CANVAS_BINDING, ...BACKGROUND].sort(),
    );
    expect(a.unavailable.every((u) => u.reason.startsWith('missing_capability:'))).toBe(true);
    expect(a.systemPrompt).not.toContain(MEDIA_GENERATION_PROMPT);
    expect(a.systemPrompt).toContain('本环境不可用的工具');
  });

  it('模式勾选 + read_only：run_in_background 因缺 workspace_write 降级；没勾的工具不装配', () => {
    const reg = registry();
    const env = {
      capabilities: new Set(['workspace', 'background'] as const),
      skillsDir: '/skills',
    };
    const a = resolveMode({
      mode: {
        id: 'm',
        name: 'x',
        systemPrompt: 'hi',
        toolNames: ['watch_until', 'run_in_background', 'preview_page'],
        mcpServerIds: [],
        skillNames: [],
        defaultModel: null,
        defaultThinkingLevel: null,
        description: null,
        subagentModeIds: [],
      },
      registry: reg,
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(a.toolDescriptors.map((t) => t.name)).toEqual(['watch_until', 'preview_page']);
    expect(a.unavailable).toEqual([{ kind: 'tool', name: 'run_in_background', reason: 'missing_capability:workspace_write' }]);
  });
});
