import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RuntimeServer } from '../mcp/mcp-types';
import type { Capability, RuntimeEnvironment } from './capabilities';
import type { AgentMode } from './mode.schema';
import { instantiateTools, resolveMode } from './resolve-mode';
import { ToolRegistry } from './tool-registry';

const mk = (name: string) =>
  tool(() => name, { name, description: name, schema: z.object({}) });

type Host = { tag: string };

function registryOf(): ToolRegistry<Host> {
  const r = new ToolRegistry<Host>();
  r.register({
    name: 'gen',
    title: '生图',
    description: '',
    requires: ['media_api'],
    promptSection: '## 生图',
    create: () => mk('gen'),
  });
  r.register({
    name: 'vid',
    title: '生视频',
    description: '',
    requires: ['media_api'],
    promptSection: '## 生图',
    create: () => mk('vid'),
  });
  r.register({
    name: 'preview',
    title: '预览',
    description: '',
    requires: ['sandbox', 'workspace'],
    create: () => mk('preview'),
    interruptOn: true,
  });
  r.register({
    name: 'mail',
    title: '邮件',
    description: '',
    requires: ['email'],
    promptSection: '## 外发',
    create: () => mk('mail'),
    interruptOn: { allowedDecisions: ['approve'] },
  });
  return r;
}

const srv = (
  id: string,
  extra: Partial<RuntimeServer> = {},
): RuntimeServer => ({
  id,
  slug: id,
  name: `Server ${id}`,
  instructions: null,
  tools: [],
  permissions: {},
  ...extra,
});

const env: RuntimeEnvironment = {
  capabilities: new Set<Capability>(['media_api', 'email']),
  skillsDir: '/skills',
};
const skills = [
  { name: 'tvc', files: { 'SKILL.md': '# tvc' } },
  { name: 'doc', files: { 'SKILL.md': '# doc' } },
];
const servers = [srv('s1'), srv('s2', { instructions: '用 s2 前先登录' })];

describe('resolveMode', () => {
  it('通用模式（null）：全部可用工具 + 全部 server + 全部技能；沙箱工具因 capability 缺失降级', () => {
    const a = resolveMode({
      mode: null,
      registry: registryOf(),
      env,
      installedSkills: skills,
      mcpServers: servers,
      envPromptBlock: '\n\n## 环境',
    });
    expect(a.toolDescriptors.map((d) => d.name)).toEqual([
      'gen',
      'vid',
      'mail',
    ]);
    expect(a.unavailable).toEqual([
      { kind: 'tool', name: 'preview', reason: 'missing_capability:sandbox' },
    ]);
    expect(a.mcpServers.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(a.skills.map((s) => s.name)).toEqual(['tvc', 'doc']);

    // 顺序：正文（已展开）→ 工具段（去重）→ MCP instructions → 环境段 → 不可用提示
    const i = (s: string) => a.systemPrompt.indexOf(s);
    expect(i('你是 Spark')).toBe(0);
    expect(a.systemPrompt).toContain('/skills/<技能名>/SKILL.md');
    expect(a.systemPrompt).not.toContain('{{');
    expect(a.systemPrompt.match(/## 生图/g)).toHaveLength(1);
    expect(i('## 回复语言')).toBeLessThan(i('## 生图'));
    expect(i('## 生图')).toBeLessThan(i('## 外发'));
    expect(i('## 外发')).toBeLessThan(i('用 s2 前先登录'));
    expect(i('用 s2 前先登录')).toBeLessThan(i('## 环境'));
    expect(i('## 环境')).toBeLessThan(i('## 本环境不可用的工具'));
    expect(a.systemPrompt).toMatch(/不可用的工具[\s\S]*`preview`/);
  });

  it('指定模式：按名过滤；缺失的 server / 技能 / 未注册工具进 unavailable；正文以模式 prompt 开头', () => {
    const mode: AgentMode = {
      id: 'm',
      name: '生图',
      systemPrompt: '生图专用\n{{platform.language}}',
      toolNames: ['gen', 'ghost'],
      mcpServerIds: ['s2', 'sX'],
      skillNames: ['tvc', 'nope'],
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    const a = resolveMode({
      mode,
      registry: registryOf(),
      env,
      installedSkills: skills,
      mcpServers: servers,
    });
    expect(a.toolDescriptors.map((d) => d.name)).toEqual(['gen']);
    expect(a.mcpServers.map((s) => s.id)).toEqual(['s2']);
    expect(a.skills.map((s) => s.name)).toEqual(['tvc']);
    expect(a.unavailable).toEqual([
      { kind: 'tool', name: 'ghost', reason: 'not_registered' },
      { kind: 'mcp_server', name: 'sX', reason: 'not_found' },
      { kind: 'skill', name: 'nope', reason: 'not_installed' },
    ]);
    expect(a.systemPrompt.startsWith('生图专用\n## 回复语言')).toBe(true);
    expect(a.systemPrompt).not.toContain('## 外发');
    // 未注册的工具不进「本环境不可用」提示（那是配置错误，不是环境问题）
    expect(a.systemPrompt).not.toContain('本环境不可用的工具');
  });

  it('promptSection 可为按环境生成的函数：只在工具被装配时出现，同文本去重', () => {
    const r = new ToolRegistry<Host>();
    const bgSection = (e: RuntimeEnvironment) =>
      e.capabilities.has('sandbox') ? '## 后台（含沙箱命令）' : '## 后台';
    r.register({
      name: 'watch',
      title: 'w',
      description: '',
      requires: ['background'],
      promptSection: bgSection,
      create: () => mk('watch'),
    });
    r.register({
      name: 'cancel',
      title: 'c',
      description: '',
      requires: ['background'],
      promptSection: bgSection,
      create: () => mk('cancel'),
    });
    r.register({
      name: 'gen',
      title: 'g',
      description: '',
      create: () => mk('gen'),
    });
    const bgEnv: RuntimeEnvironment = {
      capabilities: new Set<Capability>(['background']),
      skillsDir: '/skills',
    };

    const all = resolveMode({
      mode: null,
      registry: r,
      env: bgEnv,
      installedSkills: [],
      mcpServers: [],
    });
    expect(all.systemPrompt.match(/## 后台/g)).toHaveLength(1);
    expect(all.systemPrompt).not.toContain('含沙箱命令');

    const withSandbox = resolveMode({
      mode: null,
      registry: r,
      env: {
        ...bgEnv,
        capabilities: new Set<Capability>(['background', 'sandbox']),
      },
      installedSkills: [],
      mcpServers: [],
    });
    expect(withSandbox.systemPrompt).toContain('## 后台（含沙箱命令）');

    const mode: AgentMode = {
      id: 'm',
      name: 'x',
      systemPrompt: 'X',
      toolNames: ['gen'],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    const noBg = resolveMode({
      mode,
      registry: r,
      env: bgEnv,
      installedSkills: [],
      mcpServers: [],
    });
    expect(noBg.systemPrompt).not.toContain('## 后台');
  });

  it('通用模式可用用户覆盖的提示词（占位符照样展开）；指定模式时忽略覆盖', () => {
    const general = resolveMode({
      mode: null,
      generalPrompt: '我的通用助手\n{{platform.language}}',
      registry: registryOf(),
      env,
      installedSkills: skills,
      mcpServers: servers,
    });
    expect(general.systemPrompt.startsWith('我的通用助手\n## 回复语言')).toBe(
      true,
    );
    expect(general.systemPrompt).not.toContain('你是 Spark');
    // 工具 / server / 技能仍是全集
    expect(general.toolDescriptors.map((d) => d.name)).toEqual([
      'gen',
      'vid',
      'mail',
    ]);
    expect(general.skills).toHaveLength(2);

    const nullOverride = resolveMode({
      mode: null,
      generalPrompt: null,
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(nullOverride.systemPrompt.startsWith('你是 Spark')).toBe(true);

    const mode: AgentMode = {
      id: 'm',
      name: 'x',
      systemPrompt: '模式正文',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    const withMode = resolveMode({
      mode,
      generalPrompt: '我的通用助手',
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(withMode.systemPrompt.startsWith('模式正文')).toBe(true);
  });

  it('模式正文含未知占位符时抛错（保存时应已拦截，这里是最后防线）', () => {
    const mode: AgentMode = {
      id: 'm',
      name: 'x',
      systemPrompt: '{{platform.nope}}',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    expect(() =>
      resolveMode({
        mode,
        registry: registryOf(),
        env,
        installedSkills: [],
        mcpServers: [],
      }),
    ).toThrow(/platform\.nope/);
  });
});

describe('instantiateTools', () => {
  it('按描述符建工具、合并 interruptOn（描述符 + MCP 的 ask）', () => {
    const askServer = srv('s1', {
      tools: [
        {
          name: 'do',
          description: 'do it',
          inputSchema: { type: 'object' },
          modelSchema: { type: 'object', properties: {} },
          readOnly: false,
          destructive: false,
          visibility: ['model'],
        },
      ],
    });
    const a = resolveMode({
      mode: null,
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [askServer],
    });
    const mcpCall = jest.fn();
    const { tools, interruptOn } = instantiateTools(
      a,
      { conversationId: 'c', userId: 'u', env, host: { tag: 't' } },
      mcpCall,
    );
    expect(tools.map((t) => t.name)).toEqual(['gen', 'vid', 'mail', 's1__do']);
    expect(interruptOn).toEqual({
      mail: { allowedDecisions: ['approve'] },
      s1__do: true,
    });
  });
});
