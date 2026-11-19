import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  buildMcpAgentTools,
  buildMcpPrompt,
  type McpCaller,
} from '../mcp/mcp-agent-tools';
import type { RuntimeServer } from '../mcp/mcp-types';
import type { Capability, RuntimeEnvironment } from './capabilities';
import { type AgentMode, GENERAL_MODE_PROMPT } from './mode.schema';
import {
  type CustomFragments,
  expandPlaceholders,
  type FragmentOverrides,
} from './prompt-fragments';
import type {
  ToolCreateContext,
  ToolDescriptor,
  ToolInterruptOn,
  ToolRegistry,
} from './tool-registry';

/**
 * 按模式装配（纯函数，不建工具、不连 server，可直接给设置页做「预览最终提示词 / 哪些不可用」）。
 *
 * 系统提示拼装顺序固定（① 由作者控制，其余自动追加；①②③ 一个会话内稳定 = prompt cache 前缀）：
 *   ① 模式正文（占位符已展开；通用模式用用户覆盖的提示词，没覆盖则 GENERAL_MODE_PROMPT）
 *   ② 勾选工具的 promptSection（按首次出现顺序去重）+ MCP server 的 instructions
 *   ③ 环境段（宿主给：沙箱 execute 守则 / 本机工作区权限 / 附件说明 / 后台任务）
 *   ④ 不可用工具提示（勾了但本环境提供不了，让模型别瞎引用）
 * 动态尾段（计划、媒体清单、MCP app 上下文）不在这里，走 dynamic-context 的 provider。
 */

export interface SkillFiles {
  name: string;
  /** 相对路径 → 内容（SKILL.md 必有） */
  files: Record<string, string>;
}

export type UnavailableReason =
  | `missing_capability:${Capability}`
  | 'not_registered'
  | 'not_found'
  | 'not_installed';

export interface Unavailable {
  kind: 'tool' | 'mcp_server' | 'skill' | 'subagent';
  name: string;
  reason: UnavailableReason;
}

/** 一个子 agent 的装配结果（由被勾选的模式展开，只一层：它自己的 subagents 恒为空） */
export interface SubagentAssembly<H> {
  /** task 工具里的 subagent_type（模式名，重名时加序号） */
  name: string;
  /** 给主 agent 看的委派说明 */
  description: string;
  /** 子 agent 用的模型（模式的默认模型）；null = 跟主 agent 同一个 */
  model: string | null;
  assembly: ModeAssembly<H>;
}

export interface ResolveModeInput<H> {
  /** null = 通用模式 */
  mode: AgentMode | null;
  /** 用户覆盖的通用模式提示词（仅 mode 为 null 时用）；缺省 / null = GENERAL_MODE_PROMPT */
  generalPrompt?: string | null;
  /** 用户改写过的平台片段正文（没改写的用 core 默认） */
  fragmentOverrides?: FragmentOverrides;
  /** 用户自建片段（id → 正文），模式正文里以 {{custom.xxx}} 引用 */
  customFragments?: CustomFragments;
  registry: ToolRegistry<H>;
  env: RuntimeEnvironment;
  installedSkills: readonly SkillFiles[];
  mcpServers: readonly RuntimeServer[];
  /** ③ 环境段，由宿主按 env 提供；各段自带前导空行 */
  envPromptBlock?: string;
  /**
   * mode.subagentModeIds 指向的模式（宿主按 id 查好传进来；查不到的 id 记 unavailable）。
   * 通用模式没有子 agent。
   */
  subagentModes?: readonly AgentMode[];
}

export interface ModeAssembly<H> {
  systemPrompt: string;
  toolDescriptors: ToolDescriptor<H>[];
  mcpServers: RuntimeServer[];
  skills: SkillFiles[];
  unavailable: Unavailable[];
  subagents: SubagentAssembly<H>[];
}

/** deepagents 内置的通用子 agent 名，自定义子 agent 不能占用 */
const RESERVED_SUBAGENT_NAMES = new Set(['general-purpose']);
const DESCRIPTION_FALLBACK_CHARS = 200;

function subagentDescription(mode: AgentMode): string {
  const own = mode.description?.trim();
  if (own) return own;
  const intro = mode.systemPrompt
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_FALLBACK_CHARS);
  return `${mode.name}：${intro}`;
}

function uniqueSubagentName(base: string, taken: Set<string>): string {
  const name = base.trim() || 'subagent';
  let candidate = name;
  for (
    let i = 2;
    taken.has(candidate) || RESERVED_SUBAGENT_NAMES.has(candidate);
    i++
  ) {
    candidate = `${name}-${i}`;
  }
  taken.add(candidate);
  return candidate;
}

/** 本轮要挂载的全部技能：主 agent + 各子 agent 勾选的（按名去重；子 agent 与主 agent 共用一个技能库目录） */
export function mountableSkills<H>(assembly: ModeAssembly<H>): SkillFiles[] {
  const out = [...assembly.skills];
  for (const sub of assembly.subagents) {
    for (const s of sub.assembly.skills) {
      if (!out.some((x) => x.name === s.name)) out.push(s);
    }
  }
  return out;
}

function missingCapability(
  d: ToolDescriptor<unknown>,
  env: RuntimeEnvironment,
): Capability | undefined {
  return d.requires?.find((c) => !env.capabilities.has(c));
}

export function resolveMode<H>(input: ResolveModeInput<H>): ModeAssembly<H> {
  const { mode, registry, env } = input;
  const unavailable: Unavailable[] = [];

  // 1) 工具：模式按名查注册表；通用模式取全部。requires 任一不满足 → 降级跳过
  const candidates: ToolDescriptor<H>[] = [];
  if (mode) {
    for (const name of mode.toolNames) {
      const d = registry.get(name);
      if (d) candidates.push(d);
      else unavailable.push({ kind: 'tool', name, reason: 'not_registered' });
    }
  } else {
    candidates.push(...registry.list());
  }
  const toolDescriptors: ToolDescriptor<H>[] = [];
  for (const d of candidates) {
    const missing = missingCapability(d, env);
    if (missing) {
      unavailable.push({
        kind: 'tool',
        name: d.name,
        reason: `missing_capability:${missing}`,
      });
    } else {
      toolDescriptors.push(d);
    }
  }

  // 2) MCP：按 server id 过滤；缺的（用户删了 server）记 not_found
  let mcpServers: RuntimeServer[];
  if (mode) {
    mcpServers = [];
    for (const id of mode.mcpServerIds) {
      const s = input.mcpServers.find((x) => x.id === id);
      if (s) mcpServers.push(s);
      else
        unavailable.push({ kind: 'mcp_server', name: id, reason: 'not_found' });
    }
  } else {
    mcpServers = [...input.mcpServers];
  }

  // 3) 技能：按名过滤；没装的记 not_installed
  let skills: SkillFiles[];
  if (mode) {
    skills = [];
    for (const name of mode.skillNames) {
      const s = input.installedSkills.find((x) => x.name === name);
      if (s) skills.push(s);
      else unavailable.push({ kind: 'skill', name, reason: 'not_installed' });
    }
  } else {
    skills = [...input.installedSkills];
  }

  // 4) 系统提示
  const body = mode
    ? mode.systemPrompt
    : (input.generalPrompt ?? GENERAL_MODE_PROMPT);
  let systemPrompt = expandPlaceholders(body, {
    skillsDir: env.skillsDir,
    overrides: input.fragmentOverrides,
    custom: input.customFragments,
  });
  const sections: string[] = [];
  for (const d of toolDescriptors) {
    const section =
      typeof d.promptSection === 'function'
        ? d.promptSection(env)
        : d.promptSection;
    if (section && !sections.includes(section)) sections.push(section);
  }
  for (const s of sections) systemPrompt += `\n\n${s}`;
  systemPrompt += buildMcpPrompt(mcpServers, []);
  systemPrompt += input.envPromptBlock ?? '';
  // 只提环境提供不了的；not_registered 是配置残留（工具已下线），模型不需要知道
  const droppedTools = unavailable.filter(
    (u) => u.kind === 'tool' && u.reason.startsWith('missing_capability:'),
  );
  if (droppedTools.length) {
    systemPrompt +=
      '\n\n## 本环境不可用的工具\n' +
      '以下工具在当前模式里被勾选，但当前运行环境提供不了，本轮没有装配——不要尝试调用，' +
      '用户问起时如实说明：' +
      droppedTools.map((u) => `\`${u.name}\``).join('、');
  }

  // 5) 子 agent：只展开一层（子 agent 自己勾的子 agent 不生效，也就不会成环）
  const subagents: SubagentAssembly<H>[] = [];
  if (mode) {
    const taken = new Set<string>();
    for (const id of mode.subagentModeIds) {
      const sub = input.subagentModes?.find((m) => m.id === id);
      if (!sub || sub.id === mode.id) {
        unavailable.push({ kind: 'subagent', name: id, reason: 'not_found' });
        continue;
      }
      subagents.push({
        name: uniqueSubagentName(sub.name, taken),
        description: subagentDescription(sub),
        model: sub.defaultModel,
        assembly: resolveMode({
          ...input,
          mode: { ...sub, subagentModeIds: [] },
          subagentModes: [],
        }),
      });
    }
  }

  return {
    systemPrompt,
    toolDescriptors,
    mcpServers,
    skills,
    unavailable,
    subagents,
  };
}

/** buildAgent 用的子 agent 规格（工具已实例化） */
export interface SubagentSpec {
  name: string;
  description: string;
  systemPrompt: string;
  tools: StructuredToolInterface[];
  /** 子 agent 自己工具的审批表（宿主的运行期覆盖由 buildAgent 合并进来） */
  interruptOn: Record<string, ToolInterruptOn>;
  /** null = 与主 agent 同一个模型 */
  model: string | null;
  /** 勾了技能：挂上与主 agent 同一个技能库目录 */
  skills: boolean;
}

export interface InstantiatedTools {
  tools: StructuredToolInterface[];
  interruptOn: Record<string, ToolInterruptOn>;
  subagents: SubagentSpec[];
}

function toolsOf<H>(
  assembly: ModeAssembly<H>,
  ctx: ToolCreateContext<H>,
  mcpCall: McpCaller,
): Omit<InstantiatedTools, 'subagents'> {
  const tools: StructuredToolInterface[] = [];
  const interruptOn: Record<string, ToolInterruptOn> = {};
  for (const d of assembly.toolDescriptors) {
    tools.push(d.create(ctx));
    if (d.interruptOn) interruptOn[d.name] = d.interruptOn;
  }
  const mcp = buildMcpAgentTools(assembly.mcpServers, mcpCall);
  tools.push(...mcp.tools);
  Object.assign(interruptOn, mcp.interruptOn);
  return { tools, interruptOn };
}

/**
 * 按装配结果建工具实例：描述符 create(ctx) + MCP 工具（调用时才短连）；需审批的合并进 interruptOn。
 * 子 agent 的工具按各自的装配结果另建一份（同一 ctx：shareFactory 的工厂在一轮内只跑一次）。
 */
export function instantiateTools<H>(
  assembly: ModeAssembly<H>,
  ctx: ToolCreateContext<H>,
  mcpCall: McpCaller,
): InstantiatedTools {
  return {
    ...toolsOf(assembly, ctx, mcpCall),
    subagents: assembly.subagents.map((sub) => ({
      name: sub.name,
      description: sub.description,
      systemPrompt: sub.assembly.systemPrompt,
      model: sub.model,
      skills: sub.assembly.skills.length > 0,
      ...toolsOf(sub.assembly, ctx, mcpCall),
    })),
  };
}
