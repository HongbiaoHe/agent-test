// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；这里不需要真实提供方
jest.mock('./sandbox-providers', () => ({}));
import { MEDIA_GENERATION_PROMPT } from '@agent-test/agent-core/media/media-prompt';
import type { BackgroundService } from '../background/background.service';
import type { MediaService } from '../media/media.service';
import { SEND_EMAIL_SECTION } from './backend-prompt';
import {
  backendEnvironment,
  backendEnvPromptBlock,
  buildBackendRegistry,
} from './tool-registry.provider';

const media = {} as unknown as MediaService;
const background = {} as unknown as BackgroundService;

describe('buildBackendRegistry', () => {
  const registry = buildBackendRegistry({ media, background });

  it('注册顺序固定：邮件 → 媒体 ×5 → 沙箱工具 ×2 → 后台 ×4 → 天气', () => {
    expect(registry.list().map((d) => d.name)).toEqual([
      'send_email',
      'list_media_models',
      'generate_image',
      'generate_video',
      'generate_audio',
      'clone_voice',
      'preview_page',
      'sync_media_to_sandbox',
      'watch_until',
      'schedule_wakeup',
      'cancel_background_task',
      'run_in_background',
      'get_weather',
    ]);
  });

  it('沙箱相关工具 requires 含 sandbox', () => {
    for (const name of [
      'preview_page',
      'sync_media_to_sandbox',
      'run_in_background',
    ]) {
      expect(registry.get(name)?.requires).toContain('sandbox');
    }
    // 其它后台工具只要后台服务
    expect(registry.get('watch_until')?.requires).toEqual(['background']);
  });

  it('媒体五件套 requires 含 media_api，且共享同一段 MEDIA_GENERATION_PROMPT', () => {
    for (const name of [
      'list_media_models',
      'generate_image',
      'generate_video',
      'generate_audio',
      'clone_voice',
    ]) {
      const d = registry.get(name);
      expect(d?.requires).toContain('media_api');
      expect(d?.promptSection).toBe(MEDIA_GENERATION_PROMPT);
    }
  });

  it('send_email 需审批，提示段是「外发与不可逆动作」', () => {
    const d = registry.get('send_email');
    expect(d?.interruptOn).toBe(true);
    expect(d?.promptSection).toBe(SEND_EMAIL_SECTION);
    expect(SEND_EMAIL_SECTION.startsWith('## 外发与不可逆动作')).toBe(true);
  });

  it('沙箱工具在没有沙箱的 ctx 上构造会抛错（resolve 阶段应已过滤）', () => {
    const ctx = {
      conversationId: 'c',
      userId: 'u',
      env: backendEnvironment(null),
      host: { sandbox: null, mcpServers: [] },
    };
    expect(() => registry.get('preview_page')?.create(ctx)).toThrow(/沙箱/);
  });
});

describe('backendEnvironment', () => {
  it('有沙箱：sandbox / workspace / workspace_write + 固有三项；路径取自沙箱', () => {
    const env = backendEnvironment({
      visibleRoot: '/workspace',
      skillsDir: '/workspace/skills',
    });
    expect([...env.capabilities].sort()).toEqual(
      [
        'background',
        'email',
        'media_api',
        'sandbox',
        'workspace',
        'workspace_write',
      ].sort(),
    );
    expect(env.workspace).toBe('/workspace');
    expect(env.skillsDir).toBe('/workspace/skills');
  });

  it('无沙箱：只有固有三项，技能库目录回落 /skills', () => {
    const env = backendEnvironment(null);
    expect([...env.capabilities].sort()).toEqual([
      'background',
      'email',
      'media_api',
    ]);
    expect(env.workspace).toBeUndefined();
    expect(env.skillsDir).toBe('/skills');
  });
});

describe('backendEnvPromptBlock', () => {
  it('有工作区：沙箱守则 → 附件；后台任务说明不在环境段（随后台工具走）', () => {
    const block = backendEnvPromptBlock('/workspace');
    const i = (s: string) => block.indexOf(s);
    expect(i('## 工作区与沙箱执行')).toBeGreaterThanOrEqual(0);
    expect(i('## 工作区与沙箱执行')).toBeLessThan(i('## 用户上传的附件'));
    expect(block).not.toContain('## 后台任务与等待');
  });

  it('无工作区：没有沙箱守则，只有附件说明', () => {
    const block = backendEnvPromptBlock(undefined);
    expect(block).not.toContain('## 工作区与沙箱执行');
    expect(block).toContain('## 用户上传的附件');
    expect(block).not.toContain('## 后台任务与等待');
  });
});

describe('后台任务说明段（promptSection）', () => {
  const registry = buildBackendRegistry({ media, background });
  const section = (sandbox: boolean) => {
    const d = registry.get('watch_until');
    const env = backendEnvironment(
      sandbox
        ? { visibleRoot: '/workspace', skillsDir: '/workspace/skills' }
        : null,
    );
    return typeof d?.promptSection === 'function'
      ? d.promptSection(env)
      : d?.promptSection;
  };

  it('四个后台工具共享同一段说明；有沙箱才提 run_in_background', () => {
    for (const name of [
      'watch_until',
      'schedule_wakeup',
      'cancel_background_task',
      'run_in_background',
    ]) {
      expect(registry.get(name)?.promptSection).toBe(
        registry.get('watch_until')?.promptSection,
      );
    }
    expect(section(true)).toContain('## 后台任务与等待');
    expect(section(true)).toContain('run_in_background');
    expect(section(false)).toContain('## 后台任务与等待');
    expect(section(false)).not.toContain('run_in_background');
  });
});
