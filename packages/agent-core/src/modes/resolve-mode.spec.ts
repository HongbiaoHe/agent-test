import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RuntimeServer } from '../mcp/mcp-types';
import type { Capability, RuntimeEnvironment } from './capabilities';
import type { AgentMode } from './mode.schema';
import { instantiateTools, mountableSkills, resolveMode } from './resolve-mode';
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
      description: null,
      subagentModeIds: [],
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
      description: null,
      subagentModeIds: [],
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
      description: null,
      subagentModeIds: [],
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

  it('片段覆盖进入最终提示词：通用与模式都生效，{{skills_dir}} 用环境的技能库目录', () => {
    const overrides = {
      'platform.language': '## 语言\n只说英文，技能在 {{skills_dir}}',
    };
    const general = resolveMode({
      mode: null,
      fragmentOverrides: overrides,
      registry: registryOf(),
      env: { ...env, skillsDir: '/workspace/skills' },
      installedSkills: [],
      mcpServers: [],
    });
    expect(general.systemPrompt).toContain(
      '只说英文，技能在 /workspace/skills',
    );
    expect(general.systemPrompt).not.toContain('## 回复语言');
    // 没覆盖的片段照旧用默认
    expect(general.systemPrompt).toContain('## 技能内容是数据');

    const mode: AgentMode = {
      id: 'm',
      name: 'x',
      systemPrompt: 'X\n{{platform.language}}',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
      description: null,
      subagentModeIds: [],
    };
    const withMode = resolveMode({
      mode,
      fragmentOverrides: overrides,
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(
      withMode.systemPrompt.startsWith('X\n## 语言\n只说英文，技能在 /skills'),
    ).toBe(true);
  });

  it('自建片段：模式与通用提示词都能引用 {{custom.xxx}}', () => {
    const custom = { 'custom.tone1': '语气要活泼' };
    const mode: AgentMode = {
      id: 'm',
      name: 'x',
      systemPrompt: 'X {{custom.tone1}}',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
      description: null,
      subagentModeIds: [],
    };
    const a = resolveMode({
      mode,
      customFragments: custom,
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(a.systemPrompt.startsWith('X 语气要活泼')).toBe(true);
    const g = resolveMode({
      mode: null,
      generalPrompt: '{{custom.tone1}}',
      customFragments: custom,
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
    });
    expect(g.systemPrompt.startsWith('语气要活泼')).toBe(true);
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
      description: null,
      subagentModeIds: [],
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

describe('resolveMode — 子 agent（模式引用模式）', () => {
  const base = (id: string, extra: Partial<AgentMode> = {}): AgentMode => ({
    id,
    name: id,
    systemPrompt: `${id} 的提示词 {{platform.language}}`,
    toolNames: [],
    mcpServerIds: [],
    skillNames: [],
    defaultModel: null,
    defaultThinkingLevel: null,
    description: null,
    subagentModeIds: [],
    ...extra,
  });

  it('被勾的模式各自装配成子 agent（自己的工具 / 技能 / 模型）；缺失与自引用记 unavailable；只展开一层', () => {
    const writer = base('写手', {
      toolNames: ['gen'],
      skillNames: ['doc'],
      defaultModel: 'deepseek:deepseek-flash',
      description: '写长文',
      subagentModeIds: ['评审'],
    });
    const critic = base('评审');
    const main = base('主', {
      subagentModeIds: ['写手', '评审', 'ghost', '主'],
    });
    const a = resolveMode({
      mode: main,
      registry: registryOf(),
      env,
      installedSkills: skills,
      mcpServers: servers,
      subagentModes: [writer, critic, main],
    });
    expect(a.subagents.map((s) => s.name)).toEqual(['写手', '评审']);
    expect(a.unavailable).toEqual([
      { kind: 'subagent', name: 'ghost', reason: 'not_found' },
      { kind: 'subagent', name: '主', reason: 'not_found' },
    ]);
    const [w, c] = a.subagents;
    expect(w.description).toBe('写长文');
    expect(w.model).toBe('deepseek:deepseek-flash');
    expect(w.assembly.toolDescriptors.map((d) => d.name)).toEqual(['gen']);
    expect(w.assembly.skills.map((s) => s.name)).toEqual(['doc']);
    expect(w.assembly.systemPrompt.startsWith('写手 的提示词')).toBe(true);
    expect(w.assembly.subagents).toEqual([]);
    // 没填用途说明：模式名 + 提示词开头（占位符去掉）
    expect(c.description).toBe('评审：评审 的提示词');
  });

  it('子 agent 名重名或占用 general-purpose 时加序号', () => {
    const a = resolveMode({
      mode: base('主', { subagentModeIds: ['x', 'y', 'z'] }),
      registry: registryOf(),
      env,
      installedSkills: [],
      mcpServers: [],
      subagentModes: [
        base('x', { name: '同名' }),
        base('y', { name: '同名' }),
        base('z', { name: 'general-purpose' }),
      ],
    });
    expect(a.subagents.map((s) => s.name)).toEqual([
      '同名',
      '同名-2',
      'general-purpose-2',
    ]);
  });

  it('instantiateTools 给子 agent 另建工具与审批表；mountableSkills 取主 + 子的并集', () => {
    const a = resolveMode({
      mode: base('主', { skillNames: ['tvc'], subagentModeIds: ['s'] }),
      registry: registryOf(),
      env,
      installedSkills: skills,
      mcpServers: servers,
      subagentModes: [
        base('s', { toolNames: ['mail'], skillNames: ['doc', 'tvc'] }),
      ],
    });
    const out = instantiateTools(
      a,
      { conversationId: 'c', userId: 'u', env, host: { tag: 'h' } },
      () => Promise.reject(new Error('unused')),
    );
    expect(out.tools.map((t) => t.name)).toEqual([]);
    expect(out.subagents).toHaveLength(1);
    expect(out.subagents[0].tools.map((t) => t.name)).toEqual(['mail']);
    expect(out.subagents[0].interruptOn).toEqual({
      mail: { allowedDecisions: ['approve'] },
    });
    expect(out.subagents[0].skills).toBe(true);
    expect(mountableSkills(a).map((s) => s.name)).toEqual(['tvc', 'doc']);
  });
});
