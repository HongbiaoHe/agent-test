// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；这里不需要真实提供方
jest.mock('./sandbox-providers', () => ({}));
import { resolveMode } from '@agent-test/agent-core/modes/resolve-mode';
import type { BackgroundService } from '../background/background.service';
import type { MediaService } from '../media/media.service';
import type { GuardedSandbox } from './guarded-sandbox';
import {
  backendEnvironment,
  backendEnvPromptBlock,
  buildBackendRegistry,
} from './tool-registry.provider';

/**
 * 锁住 backend 通用模式（modeId 为空）装配出的静态系统提示：全部注册工具 + 环境段，
 * 由 agent-core 的 resolveMode 按「模式正文 → 工具段 → MCP 说明 → 环境段 → 不可用工具提示」拼装。
 * 无沙箱时沙箱相关工具按 capability 降级，末尾多出「本环境不可用的工具」一段。
 */
describe('backend 通用模式系统提示快照', () => {
  const registry = buildBackendRegistry({
    media: {} as unknown as MediaService,
    background: {} as unknown as BackgroundService,
  });

  function generalPrompt(sandbox: GuardedSandbox | null) {
    const env = backendEnvironment(sandbox);
    return resolveMode({
      mode: null,
      registry,
      env,
      installedSkills: [],
      mcpServers: [],
      envPromptBlock: backendEnvPromptBlock(env.workspace),
    }).systemPrompt;
  }

  it('无沙箱', () => {
    expect(generalPrompt(null)).toMatchSnapshot();
  });

  it('有沙箱（/workspace）', () => {
    expect(
      generalPrompt({
        visibleRoot: '/workspace',
        skillsDir: '/workspace/skills',
      } as GuardedSandbox),
    ).toMatchSnapshot();
  });
});
