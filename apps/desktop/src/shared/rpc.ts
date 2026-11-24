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
import {
  FragmentTextSchema,
  FragmentTitleSchema,
  type PromptFragmentId,
} from '@agent-test/agent-core/modes/prompt-fragments';
import type { Unavailable } from '@agent-test/agent-core/modes/resolve-mode';
import type { ToolCatalogEntry } from '@agent-test/agent-core/modes/tool-registry';
import { THINKING_LEVELS } from '@agent-test/agent-core/agent/thinking-level';
import { PROVIDER_PROTOCOLS, THINKING_STYLES } from '@agent-test/agent-core/providers/types';
import { z } from 'zod';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ReviewFile, VideoProject } from '@agent-test/video-schema';
import {
  CACHE_CATEGORIES,
  type ClearCacheResult,
  type DeleteConversationsResult,
  SHARED_CACHE_CATEGORIES,
  type StorageReport,
} from './storage';
import type {
  AigcCatalog,
  ApplyOpResult,
  CanvasListItem,
  CanvasOpInput,
  CanvasSnapshot,
} from '@agent-test/canvas-schema';
import { CANVAS_INLINE_UPLOAD_MAX_BYTES, type CanvasStreamEvent } from './canvas';
import type { ConnectResult, McpAppResource, McpPreset, McpServer } from './mcp';
import type { ConnectionTestResult, LlmConnectionView, LlmModelView, ModelOption } from './llm';
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
  /** 对话绑定的当前画布（Web 账号下的画布 id）；null = 没有。agent 的画布工具操作它 */
  canvasId: string | null;
}

/** 设置页「模式」编辑器的目录：可勾选的工具 / 连接器 / 技能、片段占位符、通用提示词（生效的，含用户覆盖）、本环境能力 */
export interface ModeCatalog {
  tools: ToolCatalogEntry[];
  mcpServers: { id: string; name: string; slug: string }[];
  skills: { name: string; description: string }[];
  /** 可插入的片段 id：内置 platform.* 在前，自建 custom.* 在后 */
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

/**
 * 一个片段：
 * - builtin：内置平台片段（{{platform.xxx}}），本机只存一份改写，没改写的用 core 默认正文；
 * - custom：用户自建片段（{{custom.xxx}}），id 创建后不可改，没有默认正文。
 */
export type PromptFragmentView =
  | {
      kind: 'builtin';
      id: PromptFragmentId;
      title: null;
      /** 生效正文（改写过取改写，否则 = defaultText）；里面的 {{skills_dir}} 未替换 */
      text: string;
      /** core 的默认正文（「恢复默认」回填用；renderer 不能从 core 的 CJS dist 取值） */
      defaultText: string;
      /** 是否改写过默认正文 */
      isCustom: boolean;
    }
  | {
      kind: 'custom';
      id: string;
      title: string;
      text: string;
      defaultText: null;
      /** 自建片段没有默认正文可「改写」，恒为 false */
      isCustom: false;
    };

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

export type {
  ConnectionTestResult,
  LlmConnectionView,
  LlmModelView,
  ModelCapabilities,
  ModelOption,
  ModelTestResult,
  ProviderProtocol,
} from './llm';

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
  /** 当前账号的默认模型（「连接 id/模型 id」）；没设过为 null */
  defaultModel: string | null;
  /** 至少有一个已启用的模型：没有时界面引导用户先添加 API 连接，发送按钮置灰 */
  hasModels: boolean;
}

const id = z.string().min(1);

/** 画布结构编辑 op：形状由 Web 后端校验（canvas.op-schema），这里只确认是个带 op 字段的对象 */
const canvasOpInput = z.custom<CanvasOpInput>(
  (v) => typeof v === 'object' && v !== null && 'op' in v && typeof v.op === 'string',
);

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

/** ── 视频剪辑器（videos/*.sparkvideo.json，见 @agent-test/video-schema）──────────────────── */

/** 时间线视频轨的预览帧拼图（agent-host/video/thumbnails.ts 生成） */
export interface VideoThumbnails {
  /** data:image/jpeg;base64,… 横排拼图 */
  sprite: string;
  /** 格子数 */
  count: number;
  /** 第 k 格 = 素材 k × interval 秒处 */
  interval: number;
  tileWidth: number;
  tileHeight: number;
}

/** 工作区里的一个剪辑工程（列表用） */
export interface VideoProjectSummary {
  /** 工作区相对路径，如 videos/promo.sparkvideo.json */
  path: string;
  name: string;
  /** 成片时长（秒）；工程损坏时为 null */
  duration: number | null;
  /** 文件修改时间（ms） */
  mtimeMs: number;
}

/** 读工程：损坏（JSON 解析失败 / schema 不过）时 project 为 null，issues 给出原因，编辑器据此报错而不是白屏 */
export interface VideoProjectFile {
  path: string;
  project: VideoProject | null;
  issues: string[];
  /** 文件修改时间（ms）：写回时作为 baseMtimeMs 做冲突检测 */
  mtimeMs: number;
}

/** 写工程：baseMtimeMs 与磁盘不一致 = 期间被外部（agent）改过，不写入，返回 conflict */
export type VideoWriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number };

/** ffprobe 读出的素材信息 */
export interface VideoMediaProbe {
  /** 工作区相对路径 */
  path: string;
  kind: 'video' | 'audio' | 'image';
  /** 秒；图片为 null */
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

export type VideoExportStatus = 'running' | 'done' | 'failed' | 'cancelled';

export const rpcSchemas = {
  'host.status': z.object({}),
  /** 模型下拉：当前账号所有已启用的模型（按连接分组展示） */
  'models.list': z.object({}),
  'llm.connections.list': z.object({}),
  'llm.connections.create': z.object({
    name: z.string().trim().min(1).max(100),
    protocol: z.enum(PROVIDER_PROTOCOLS),
    baseUrl: z.url().max(500),
    presetId: z.string().min(1).nullable(),
  }),
  /** 名称与 Base URL 可改；协议不能改 */
  'llm.connections.update': z.object({
    id,
    name: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.url().max(500).optional(),
  }),
  'llm.connections.delete': z.object({ id }),
  /** 测连接：请求一次模型列表接口（不消耗 token） */
  'llm.connections.test': z.object({ id }),
  'llm.models.list': z.object({ connectionId: id }),
  /** 刷新：拉取模型列表并合并（新出现的标 new，没拉到的标 missing，不自动改启用状态） */
  'llm.models.refresh': z.object({ connectionId: id }),
  /** 手填模型 id（服务没有 /models 或列表不全）；默认启用 */
  'llm.models.add': z.object({ connectionId: id, modelId: z.string().trim().min(1).max(200) }),
  'llm.models.setEnabled': z.object({
    connectionId: id,
    modelIds: z.array(z.string().min(1)).min(1).max(2000),
    enabled: z.boolean(),
  }),
  'llm.models.remove': z.object({ connectionId: id, modelId: z.string().min(1) }),
  'llm.models.updateCapabilities': z.object({
    connectionId: id,
    modelId: z.string().min(1),
    capabilities: z.object({
      thinkingStyle: z.enum(THINKING_STYLES),
      thinkingLevels: z.array(z.enum(THINKING_LEVELS)).min(1),
      contextWindow: z.number().int().positive().nullable(),
      reasoningSummary: z.boolean().optional(),
    }),
  }),
  /** 测模型：带一个假工具发一次最小请求（会消耗少量 token） */
  'llm.models.test': z.object({ connectionId: id, modelId: z.string().min(1) }),
  /** 账号默认模型；null = 清除（新会话按第一个启用的模型） */
  'llm.defaultModel.set': z.object({ ref: z.string().min(1).nullable() }),
  'conversations.list': z.object({}),
  'conversations.create': z.object({
    model: z.string().optional(),
    workspaceDir: z.string().min(1).optional(),
    permission: z.enum(WORKSPACE_PERMISSIONS).optional(),
    /** 所选模式；模式带默认模型 / 思考档位时只在这里回填（之后以会话自己的值为准） */
    modeId: z.string().min(1).optional(),
    /** 有空会话时复用它（默认）；false = 一定新建（画布对话栏：开跑失败会删掉它，不能删到用户已有的会话） */
    reuseEmpty: z.boolean().optional(),
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
  /** 删除会话：连同本机的消息、缓存、运行目录与它新建的产出文件（产出移进废纸篓） */
  'conversations.delete': z.object({ id }),
  /** 设置 → 存储：扫描当前账号每个会话的本机占用 */
  'storage.scan': z.object({}),
  /** 清缓存：不给 conversationIds = 全部会话；正在运行 / 等审批的会话跳过 */
  'storage.clearCache': z.object({
    conversationIds: z.array(id).max(5000).optional(),
    categories: z.array(z.enum(CACHE_CATEGORIES)),
    sharedCategories: z.array(z.enum(SHARED_CACHE_CATEGORIES)).optional(),
  }),
  'storage.deleteConversations': z.object({ ids: z.array(id).min(1).max(5000) }),
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
  /** 内置 4 个平台片段（固定顺序），其后是自建片段（按 id 排序） */
  'modes.fragments.list': z.object({}),
  /**
   * 改片段：内置片段只能改 text（null 或与默认相同 = 恢复默认）；自建片段可改 title / text（text 不能为 null）。
   * 正文里只能用 {{skills_dir}}，未知 id 报错
   */
  'modes.fragments.update': z.object({
    id: z.string().min(1),
    text: FragmentTextSchema.nullable().optional(),
    title: FragmentTitleSchema.optional(),
  }),
  /** 新建自建片段：id 须为 custom.<小写字母 / 数字 / 下划线，1～48 位>（host 校验并给出本地化报错），已存在报错 */
  'modes.fragments.create': z.object({ id: z.string().min(1), title: FragmentTitleSchema, text: FragmentTextSchema }),
  /** 删除自建片段：内置片段不能删；仍被模式或自定义的通用提示词引用时拒绝并列出引用处 */
  'modes.fragments.delete': z.object({ id: z.string().min(1) }),
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
  'media.asset': z.object({ versionId: id }),
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
  // 视频剪辑器：path 一律是工作区相对路径，conversationId 决定是哪个工作区
  'video.list': z.object({ conversationId: z.string().min(1) }),
  /** 读工程，同时开始监听该文件（外部修改推 video-file-changed） */
  'video.read': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  /** 不再监听（编辑器关闭 / 切换工程时调用） */
  'video.close': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  /** 写回工程：project 在 host 侧用 parseProject 校验，不合法直接报错 */
  'video.write': z.object({
    conversationId: z.string().min(1),
    path: z.string().min(1),
    project: z.unknown(),
    /** 读取时的 mtimeMs；省略 = 强制覆盖（用户在冲突提示里选了「保留我的修改」） */
    baseMtimeMs: z.number().optional(),
  }),
  'video.probe': z.object({ conversationId: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(50) }),
  /** 把用户在本机选的文件复制进工作区 media/imports/，返回工作区相对路径与探测信息 */
  'video.importFiles': z.object({ conversationId: z.string().min(1), sourcePaths: z.array(z.string().min(1)).min(1).max(20) }),
  /** 导出成片到 exports/：height 为 null = 按工程画布原尺寸，否则按该高度等比缩放（720 / 1080） */
  'video.export': z.object({
    conversationId: z.string().min(1),
    path: z.string().min(1),
    height: z.union([z.literal(720), z.literal(1080)]).nullable(),
    /** 字幕原文 → 剪辑器按预览同一字体量宽断好行的文本（行间 \n），导出按它排，与预览一致 */
    wrappedSubtitles: z.record(z.string(), z.string()).optional(),
  }),
  'video.exportCancel': z.object({ jobId: z.string().min(1) }),
  /** 还能撤销几轮 agent 修改（agent 写工程前存的快照） */
  'video.snapshots': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  /** 撤销 agent 最近一轮修改：最新快照写回工程文件 */
  'video.restoreSnapshot': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  /** 工程旁边的审片结果（<名字>.review.json）；没有为 null */
  'video.readReview': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  /** 视频素材的预览帧拼图（path = 素材的工作区相对路径） */
  'video.thumbnails': z.object({ conversationId: z.string().min(1), path: z.string().min(1) }),
  // 画布（数据在 Web 账号下，agent-host 代为调用 Web 后端的 /canvas 接口；规则由服务端执行）
  'canvas.list': z.object({ cursor: z.string().min(1).optional() }),
  'canvas.create': z.object({ title: z.string().max(100).optional() }),
  'canvas.snapshot': z.object({ id }),
  'canvas.rename': z.object({ id, title: z.string().min(1).max(100) }),
  /** 用户结构编辑；op 的形状由 Web 后端校验（canvas.op-schema），这里只确认是个 op 对象 */
  'canvas.applyOp': z.object({ id, op: canvasOpInput, baseRevision: z.number().int().min(0) }),
  'canvas.move': z.object({ id, nodeId: id, x: z.number(), y: z.number() }),
  'canvas.generate': z.object({ id, nodeId: id }),
  'canvas.merge': z.object({ id, nodeId: id }),
  'canvas.pauseMedia': z.object({ id, nodeId: id.optional() }),
  'canvas.resumeMedia': z.object({ id, nodeId: id.optional() }),
  'canvas.setFocus': z.object({ id, nodeIds: z.array(id).max(500) }),
  /**
   * 上传节点的文件：优先给本机路径（host 从磁盘流式转发到 Web 后端，不经 MessagePort 搬字节）；
   * 拿不到路径的（如剪贴板里的图）才传字节，限 CANVAS_INLINE_UPLOAD_MAX_BYTES
   */
  'canvas.uploadNodeFile': z.object({
    id,
    nodeId: id,
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('path'), path: z.string().min(1) }),
      z.object({
        kind: z.literal('bytes'),
        bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength <= CANVAS_INLINE_UPLOAD_MAX_BYTES),
      }),
    ]),
    contentType: z.string().min(1).max(200),
    filename: z.string().min(1).max(255),
  }),
  'canvas.aigcModels': z.object({ type: z.enum(['image', 'video']) }),
  /** 画布视图打开 / 关闭：开始 / 停止转发这块画布的实时事件（canvas 事件） */
  'canvas.watch': z.object({ id }),
  'canvas.unwatch': z.object({ id }),
  /** 从画布列表打开时右侧对话栏显示哪个对话：最近一个绑定着它的本地对话；没有为 null */
  'canvas.latestConversation': z.object({ id }),
  /** 把对话的当前画布切到这一块（用户在对话里点开画布卡片 / 在画布视图里发第一条消息） */
  'conversations.setCanvas': z.object({ conversationId: id, canvasId: id.nullable() }),
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
  'llm.connections.list': LlmConnectionView[];
  'llm.connections.create': LlmConnectionView;
  'llm.connections.update': LlmConnectionView;
  'llm.connections.delete': { ok: true };
  'llm.connections.test': ConnectionTestResult;
  'llm.models.list': LlmModelView[];
  'llm.models.refresh': LlmModelView[];
  'llm.models.add': LlmModelView;
  'llm.models.setEnabled': { ok: true };
  'llm.models.remove': { ok: true };
  'llm.models.updateCapabilities': LlmModelView;
  'llm.models.test': LlmModelView;
  'llm.defaultModel.set': HostStatus;
  'conversations.list': ConversationSummary[];
  'conversations.create': ConversationSummary;
  'conversations.get': ConversationDetail;
  'conversations.update': ConversationSummary;
  'conversations.delete': { ok: true };
  'storage.scan': StorageReport;
  'storage.clearCache': ClearCacheResult;
  'storage.deleteConversations': DeleteConversationsResult;
  'modes.list': AgentMode[];
  'modes.create': AgentMode;
  'modes.update': AgentMode;
  'modes.delete': { ok: true };
  'modes.catalog': ModeCatalog;
  'modes.preview': ModePreview;
  'modes.general.get': GeneralModeView;
  'modes.general.update': GeneralModeView;
  'modes.general.preview': ModePreview;
  'modes.fragments.list': PromptFragmentView[];
  'modes.fragments.update': PromptFragmentView;
  'modes.fragments.create': PromptFragmentView;
  'modes.fragments.delete': { ok: true };
  'conversations.search': ConversationSearchHit[];
  'conversations.tokenReport': TokenReport;
  'background.list': BackgroundTaskView[];
  /** Web 后端 GET /media-api/generations 的原样结果（形状同 Web 前端 MediaGeneration[]，renderer 侧再校验） */
  'media.list': unknown;
  'media.regenerate': unknown;
  'media.source': { url: string | null };
  /**
   * 没有 CDN 地址的版本（拼接成片、测试模式占位图等）：agent-host 带令牌取回的本地资产。
   * 字节用 base64：RPC 结果回包前会过一遍 JSON（agent-host/index.ts），Uint8Array 过不去
   */
  'media.asset': { base64: string; contentType: string };
  'web.status': { enabled: boolean; apiUrl: string | null };
  'background.cancel': BackgroundTaskView;
  'workspace.list': { root: string; entries: DirEntry[] };
  'workspace.read': FilePreview;
  'run.start': { ok: true };
  'run.resume': { ok: true };
  'run.stop': { ok: true };
  'canvas.list': { items: CanvasListItem[]; nextCursor: string | null };
  'canvas.create': { sessionId: string };
  'canvas.snapshot': CanvasSnapshot;
  'canvas.rename': { ok: true };
  'canvas.applyOp': ApplyOpResult;
  'canvas.move': { ok: true };
  'canvas.generate': { generationId: string };
  'canvas.merge': { generationId: string };
  'canvas.pauseMedia': { paused: number; skipped: number };
  'canvas.resumeMedia': { ok: true };
  'canvas.setFocus': { focusNodeIds: string[] };
  'canvas.uploadNodeFile': { generationId: string; versionId: string };
  'canvas.aigcModels': AigcCatalog;
  'canvas.watch': { ok: true };
  'canvas.unwatch': { ok: true };
  'canvas.latestConversation': ConversationSummary | null;
  'conversations.setCanvas': ConversationSummary;
  'video.list': VideoProjectSummary[];
  'video.read': VideoProjectFile;
  'video.close': { ok: true };
  'video.write': VideoWriteResult;
  'video.probe': VideoMediaProbe[];
  'video.importFiles': VideoMediaProbe[];
  'video.export': { jobId: string; outputPath: string };
  'video.exportCancel': { ok: true };
  'video.snapshots': { count: number; latestAt: number | null };
  'video.restoreSnapshot': { count: number; latestAt: number | null };
  'video.readReview': ReviewFile | null;
  'video.thumbnails': VideoThumbnails;
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
  /** 模式增删改、通用模式 / 平台片段改写（设置页列表、会话内选择器据此刷新） */
  | { kind: 'event'; type: 'modes-changed' }
  /** API 连接 / 模型 / 默认模型变了（设置页、模型下拉据此刷新） */
  | { kind: 'event'; type: 'llm-changed' }
  /** 打开着的画布的实时事件（Web 后端画布事件流经 agent-host 转发，见 shared/canvas.ts） */
  | { kind: 'event'; type: 'canvas'; canvasId: string; event: CanvasStreamEvent }
  /** 编辑器正在打开的工程文件被外部（agent / 用户手改）修改了 */
  | { kind: 'event'; type: 'video-file-changed'; conversationId: string; path: string; mtimeMs: number }
  /** 工程旁边的审片结果文件变了（path 是工程路径） */
  | { kind: 'event'; type: 'video-review-changed'; conversationId: string; path: string }
  /** 导出进度：progress 0～1；done 时带 outputPath（工作区相对），failed 时带 error */
  | {
      kind: 'event';
      type: 'video-export';
      jobId: string;
      status: VideoExportStatus;
      progress: number;
      outputPath?: string;
      error?: string;
    }
  /** 系统浏览器里的 OAuth 授权完成（loopback 回调）：成功 / 失败都推，连接中的按钮据此结束 */
  | { kind: 'event'; type: 'mcp-oauth'; ok: boolean; serverId?: string; error?: string };

export function isMethod(v: unknown): v is RpcMethod {
  return typeof v === 'string' && Object.hasOwn(rpcSchemas, v);
}
