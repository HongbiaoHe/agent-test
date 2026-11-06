/**
 * renderer ↔ agent-host 的 RPC 协议（经 main 转交的 MessagePort 直连，不经 main 中转）。
 *
 * - 参数用 zod 定义：agent-host 收到请求先 parse，renderer 侧用 z.input 推出调用类型；
 * - 结果类型在 RpcResults 里声明（结果是 agent-host 自己产出的数据，经结构化克隆原样到达）；
 * - 运行中的流式事件以 HostEvent 推送。
 */
import type { TokenReport } from '@agent-test/agent-core/agent/token-usage';
import type { Capability } from '@agent-test/agent-core/modes/capabilities';
import {
  type AgentMode,
  AgentModeInputSchema,
  GeneralModeSettingsSchema,
} from '@agent-test/agent-core/modes/mode.schema';
import type { Unavailable } from '@agent-test/agent-core/modes/resolve-mode';
import type { ToolCatalogEntry } from '@agent-test/agent-core/modes/tool-registry';
import { z } from 'zod';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectResult, McpAppResource, McpPreset, McpServer } from './mcp';
import { WORKSPACE_PERMISSIONS, type WorkspacePermission } from './workspace';

export type { TokenReport };

export const CONVERSATION_STATUSES = [
  'idle',
  'running',
  'waiting_approval',
  'done',
  'failed',
  'stopped',
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface ConversationSummary {
  id: string;
  title: string | null;
  goal: string;
  status: ConversationStatus;
  model: string | null;
  thinkingLevel: string | null;
  /** 会话工作区（已解析：旧会话没存过时取当前默认工作区） */
  workspaceDir: string;
  permission: WorkspacePermission;
  createdAt: number;
  updatedAt: number;
  /** 置顶时刻（ms）；未置顶为 null。侧栏「已置顶」按它倒序 */
  pinnedAt: number | null;
  /** 会话所选 agent 模式；null = 通用模式（全部工具 / 连接器 / 技能） */
  modeId: string | null;
}

/** 设置页「模式」编辑器的目录：可勾选的工具 / 连接器 / 技能、片段占位符、通用提示词（生效的，含用户覆盖）、本环境能力 */
export interface ModeCatalog {
  tools: ToolCatalogEntry[];
  mcpServers: { id: string; name: string; slug: string }[];
  skills: { name: string; description: string }[];
  fragments: string[];
  generalPrompt: string;
  capabilities: Capability[];
}

export interface ModePreview {
  systemPrompt: string;
  unavailable: Unavailable[];
}

/** 通用模式（modeId 为 null）的设置：名称固定、工具 / 连接器 / 技能恒为全部，只能改提示词与默认模型 */
export interface GeneralModeView {
  /** 生效的提示词：用户覆盖过取覆盖，否则 = defaultPrompt */
  systemPrompt: string;
  /** 用户是否覆盖过提示词（库里 system_prompt 非 NULL） */
  isCustom: boolean;
  /** core 的 GENERAL_MODE_PROMPT（「恢复默认」回填用；renderer 不能从 core 的 CJS dist 取值） */
  defaultPrompt: string;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}

/** 会话搜索的一条结果：snippet 是命中的消息片段（只命中标题时为 null） */
export interface ConversationSearchHit {
  conversation: ConversationSummary;
  snippet: string | null;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: string;
  type: string;
  content: unknown;
  createdAt: number;
}

/** 用户消息里的一个附件：已复制进会话运行目录（path 为本机绝对路径）。 */
export interface AttachmentRef {
  filename: string;
  path: string;
  size: number;
  /** 登录 Web 账号时，图片 / 视频 / 音频附件同时上传成生成素材：versionId 可被 referenceVersionIds 引用 */
  versionId?: string;
  mediaType?: string;
  url?: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: StoredMessage[];
  /** 会话累计 token（token_usage 表求和） */
  totalTokens: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: 'google' | 'deepseek';
  thinkingLevels: string[];
}

/** 技能来源分类：内置（随应用发布）/ GitHub 安装 / 本地自建或文件夹导入 */
export type SkillKind = 'builtin' | 'github' | 'custom';

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  kind: SkillKind;
  installedAt: number;
}

/** 技能详情：文件列表（相对技能目录）+ SKILL.md 原文 + 去掉 frontmatter 的正文 */
export interface SkillDetail extends SkillInfo {
  files: string[];
  skillMd: string;
  body: string;
}

export const TOOL_PERMISSION_VALUES = ['allow', 'ask', 'deny'] as const;
export type ToolPermissionValue = (typeof TOOL_PERMISSION_VALUES)[number];

export type BackgroundKind = 'watch' | 'command' | 'wakeup';
export type BackgroundStatus = 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

/** 会话后台任务（同 Web 前端 BackgroundTask / backend BackgroundTaskView，时间为 ISO 字符串） */
export interface BackgroundTaskView {
  id: string;
  conversationId: string;
  kind: BackgroundKind;
  title: string;
  status: BackgroundStatus;
  result: { text: string; value?: string; exitCode?: number } | null;
  polls: number;
  deadlineAt: string;
  finishedAt: string | null;
  createdAt: string;
}

/** 工作区文件树的一项（path 为工作区相对路径） */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

/** 文件预览：文本原文 / 图片 dataUrl / 不可预览的二进制 */
export type FilePreview =
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string; mimeType: string }
  | { kind: 'binary'; size: number };

export interface HostStatus {
  /** 新会话默认使用的工作区 */
  workspaceDir: string;
  keys: { google: boolean; deepseek: boolean };
  defaultModel: string;
}

const id = z.string().min(1);

export const hitlDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('reject'), message: z.string().optional() }),
  z.object({
    type: z.literal('edit'),
    editedAction: z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
    }),
  }),
]);
export type HitlDecision = z.infer<typeof hitlDecisionSchema>;

export const rpcSchemas = {
  'host.status': z.object({}),
  'models.list': z.object({}),
  'conversations.list': z.object({}),
  'conversations.create': z.object({
    model: z.string().optional(),
    workspaceDir: z.string().min(1).optional(),
    permission: z.enum(WORKSPACE_PERMISSIONS).optional(),
    /** 所选模式；模式带默认模型 / 思考档位时只在这里回填（之后以会话自己的值为准） */
    modeId: z.string().min(1).optional(),
  }),
  'conversations.get': z.object({ id }),
  'conversations.update': z.object({
    id,
    title: z.string().trim().min(1).max(200).optional(),
    /** 置顶 / 取消置顶（不改 updatedAt，会话不会因此跳到「今天」） */
    pinned: z.boolean().optional(),
    model: z.string().optional(),
    thinkingLevel: z.string().nullable().optional(),
    permission: z.enum(WORKSPACE_PERMISSIONS).optional(),
    /** 只有还没发过消息的会话能改目录（附件、历史里的路径都依赖它） */
    workspaceDir: z.string().min(1).optional(),
    /** 切模式：null = 回到通用模式；运行中 / 等审批时拒绝 */
    modeId: z.string().nullable().optional(),
  }),
  'conversations.delete': z.object({ id }),
  'modes.list': z.object({}),
  'modes.create': AgentModeInputSchema,
  'modes.update': AgentModeInputSchema.extend({ id }),
  'modes.delete': z.object({ id }),
  'modes.catalog': z.object({}),
  /** 用编辑中的内容算最终系统提示与不可用清单（不落库） */
  'modes.preview': AgentModeInputSchema,
  'modes.general.get': z.object({}),
  /** 整份覆盖；systemPrompt 为 null = 恢复默认提示词 */
  'modes.general.update': GeneralModeSettingsSchema,
  /** 用编辑中的通用提示词算最终系统提示（不落库）；null = 默认提示词 */
  'modes.general.preview': GeneralModeSettingsSchema.pick({ systemPrompt: true }),
  /** 按标题与消息正文搜索（不区分大小写的子串匹配） */
  'conversations.search': z.object({ query: z.string().trim().min(1).max(200) }),
  'conversations.tokenReport': z.object({ id }),
  'background.list': z.object({ conversationId: id }),
  /** Web 账号的媒体（生图 / 生视频 / 配音卡片）：未登录时报错 */
  'media.list': z.object({ conversationId: id }),
  'media.regenerate': z.object({
    generationId: id,
    prompt: z.string().max(2000).optional(),
    referenceVersionIds: z.array(z.string()).max(4).optional(),
  }),
  'media.source': z.object({ versionId: id }),
  'web.status': z.object({}),
  'background.cancel': z.object({ taskId: id }),
  'workspace.list': z.object({ conversationId: id, path: z.string().default('') }),
  'workspace.read': z.object({ conversationId: id, path: z.string().min(1) }),
  'run.start': z.object({
    conversationId: id,
    text: z.string(),
    /** 用户选中的本地文件绝对路径；agent-host 复制进工作区后再记进消息 */
    attachments: z.array(z.string()).default([]),
  }),
  'run.resume': z.object({
    conversationId: id,
    decisions: z.array(hitlDecisionSchema).min(1),
  }),
  'run.stop': z.object({ conversationId: id }),
  'skills.list': z.object({}),
  'skills.get': z.object({ name: id }),
  'skills.install': z.object({ folder: z.string().min(1) }),
  /** GitHub 安装，source 兼容 npx skills add 写法：owner/repo[@skill]、GitHub 链接、--skill 名字 */
  'skills.installFromGithub': z.object({ source: z.string().min(1).max(500) }),
  'skills.saveCustom': z.object({
    name: id,
    description: z.string().min(1).max(1024),
    body: z.string().max(100_000),
    mode: z.enum(['create', 'edit']),
  }),
  'skills.setEnabled': z.object({ name: id, enabled: z.boolean() }),
  'skills.remove': z.object({ name: id }),
  'mcp.list': z.object({}),
  /** 添加并立即连接（同 Web POST /mcp/servers）：https；http 只允许本机地址 */
  'mcp.add': z.object({
    url: z.url({ protocol: /^https?$/ }),
    name: z.string().min(1).max(60).optional(),
  }),
  'mcp.addPreset': z.object({ key: z.string().min(1) }),
  'mcp.remove': z.object({ id }),
  'mcp.connect': z.object({ id }),
  /** 断开：清 token（保留动态注册的 client），工具快照留着供查看 */
  'mcp.disconnect': z.object({ id }),
  'mcp.update': z.object({
    id,
    enabled: z.boolean().optional(),
    toolPermissions: z.record(z.string(), z.enum(TOOL_PERMISSION_VALUES)).optional(),
  }),
  'mcp.appResource': z.object({ serverId: id, uri: z.string().min(1) }),
  'mcp.readResource': z.object({ serverId: id, uri: z.string().min(1) }),
  'mcp.callToolFromApp': z.object({
    serverId: id,
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    confirmed: z.boolean().optional(),
  }),
  'mcp.setAppContext': z.object({
    serverId: id,
    conversationId: id,
    toolCallId: z.string().min(1),
    text: z.string().max(20_000),
  }),
} as const;

export type RpcMethod = keyof typeof rpcSchemas;
export type RpcParams<M extends RpcMethod> = z.input<(typeof rpcSchemas)[M]>;
export type RpcParsedParams<M extends RpcMethod> = z.output<
  (typeof rpcSchemas)[M]
>;

export interface RpcResults {
  'host.status': HostStatus;
  'models.list': ModelOption[];
  'conversations.list': ConversationSummary[];
  'conversations.create': ConversationSummary;
  'conversations.get': ConversationDetail;
  'conversations.update': ConversationSummary;
  'conversations.delete': { ok: true };
  'modes.list': AgentMode[];
  'modes.create': AgentMode;
  'modes.update': AgentMode;
  'modes.delete': { ok: true };
  'modes.catalog': ModeCatalog;
  'modes.preview': ModePreview;
  'modes.general.get': GeneralModeView;
  'modes.general.update': GeneralModeView;
  'modes.general.preview': ModePreview;
  'conversations.search': ConversationSearchHit[];
  'conversations.tokenReport': TokenReport;
  'background.list': BackgroundTaskView[];
  /** Web 后端 GET /media-api/generations 的原样结果（形状同 Web 前端 MediaGeneration[]，renderer 侧再校验） */
  'media.list': unknown;
  'media.regenerate': unknown;
  'media.source': { url: string | null };
  'web.status': { enabled: boolean; apiUrl: string | null };
  'background.cancel': BackgroundTaskView;
  'workspace.list': { root: string; entries: DirEntry[] };
  'workspace.read': FilePreview;
  'run.start': { ok: true };
  'run.resume': { ok: true };
  'run.stop': { ok: true };
  'skills.list': SkillInfo[];
  'skills.get': SkillDetail;
  'skills.install': SkillInfo;
  'skills.installFromGithub': SkillInfo[];
  'skills.saveCustom': SkillInfo;
  'skills.setEnabled': SkillInfo;
  'skills.remove': { ok: true };
  'mcp.list': { servers: McpServer[]; presets: McpPreset[] };
  'mcp.add': ConnectResult;
  'mcp.addPreset': ConnectResult;
  'mcp.remove': { deleted: true };
  'mcp.connect': ConnectResult;
  'mcp.disconnect': McpServer;
  'mcp.update': McpServer;
  'mcp.appResource': McpAppResource;
  'mcp.readResource': ReadResourceResult;
  'mcp.callToolFromApp': CallToolResult;
  'mcp.setAppContext': { ok: true };
}

export interface RpcRequest {
  kind: 'request';
  id: number;
  method: RpcMethod;
  params: unknown;
}

export type RpcResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string };

/** 会话流式事件：type / payload 与 backend 的 RawEvent 同一套口径（token / message / tool_* / ...） */
export interface ConversationStreamEvent {
  type: string;
  payload: unknown;
  /** 事件产生时刻（毫秒），前端计时 / 时间分隔用 */
  ts: number;
}

export type HostEvent =
  | {
      kind: 'event';
      type: 'conversation';
      conversationId: string;
      event: ConversationStreamEvent;
    }
  | { kind: 'event'; type: 'conversations-changed' }
  | { kind: 'event'; type: 'mcp-changed' }
  | { kind: 'event'; type: 'skills-changed' }
  /** 模式增删改（设置页列表、会话内选择器据此刷新） */
  | { kind: 'event'; type: 'modes-changed' }
  /** 系统浏览器里的 OAuth 授权完成（loopback 回调）：成功 / 失败都推，连接中的按钮据此结束 */
  | { kind: 'event'; type: 'mcp-oauth'; ok: boolean; serverId?: string; error?: string };

export function isMethod(v: unknown): v is RpcMethod {
  return typeof v === 'string' && Object.hasOwn(rpcSchemas, v);
}
