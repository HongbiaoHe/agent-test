/**
 * 拷自 Web 的聊天组件所用的数据接口（同名同形），桌面端改由 agent-host RPC 提供。
 * Web 原版见 apps/frontend/src/lib/api.ts；这里只保留聊天界面实际用到的部分。
 */
import type { DirEntry, FilePreview, StoredMessage } from '../../../shared/rpc';
import { z } from 'zod';
import { agent } from './agent-client';
import { i18n } from './i18n';

import type {
  TokenCall,
  TokenModelUsage,
  TokenRun as CoreTokenRun,
  TokenTotals,
} from '@agent-test/agent-core/agent/token-usage';

export type { TokenCall, TokenModelUsage, TokenTotals };

/** 同 Web 前端的 TokenRun：画布才有 status / 未结束的 endedAt，Spark 对话两者都恒有值 */
export interface TokenRun extends Omit<CoreTokenRun, 'endedAt'> {
  endedAt: string | null;
  status?: string;
}

export interface TokenReport {
  totals: TokenTotals;
  byModel: TokenModelUsage[];
  runs: TokenRun[];
}

/** 历史消息（createdAt 为毫秒；Web 是 ISO 字符串，thread.ts 两种都接受） */
export type ConversationMessage = StoredMessage;

/** thread.ts buildBaseState 的输入 */
export interface Conversation {
  id: string;
  goal: string;
  title: string | null;
  status: string;
  messages: ConversationMessage[];
  totalTokens: number;
}

export type AttachmentType = 'image' | 'video' | 'audio' | 'file';

/** 用户消息里的附件：已复制到会话运行目录的本地副本 */
export interface MessageAttachment {
  filename: string;
  path: string;
  size: number;
  type: AttachmentType;
}

/** 技能来源分类（/ 补全分组）：内置 / GitHub 安装 / 本地自建或文件夹导入 */
export type SkillKind = 'builtin' | 'github' | 'custom';

export interface CommandInfo {
  name: string;
  description: string;
  kind: SkillKind;
}

/** `/skills add` 安装命令：不是技能，但放进 / 补全里方便发现（agent-host 直接执行，不交给模型）；说明按调用时的语言取 */
function skillsAddCommand(): CommandInfo {
  return { name: 'skills', description: i18n.t('settings.skillsAddCommand'), kind: 'builtin' };
}

export async function listCommands(): Promise<CommandInfo[]> {
  const skills = await agent.call('skills.list', {});
  return [
    skillsAddCommand(),
    ...skills
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description, kind: s.kind })),
  ];
}

export function getConversationTokenUsage(id: string) {
  return agent.call('conversations.tokenReport', { id });
}

export type SandboxDirEntry = DirEntry;

export function fetchSandboxDir(
  conversationId: string,
  path = '',
): Promise<{ root: string; entries: SandboxDirEntry[] }> {
  return agent.call('workspace.list', { conversationId, path });
}

export function fetchSandboxFile(conversationId: string, path: string): Promise<FilePreview> {
  return agent.call('workspace.read', { conversationId, path });
}

// ——— 生图 / 生视频 / 配音（登录 Web 账号后，经 agent-host 转调 Web 后端；类型同 Web lib/api.ts）———
export type MediaType = 'image' | 'video' | 'audio' | 'voice';
/** cancelled = 用户停止 / aigc 侧取消（与生成失败分开展示） */
export type MediaStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';

export interface MediaVersion {
  id: string;
  prompt: string;
  model: string;
  channel: string | null;
  params: Record<string, string> | null;
  status: MediaStatus;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  referenceVersionIds: string[];
}

export interface MediaGeneration {
  id: string;
  type: MediaType;
  createdAt: string;
  versions: MediaVersion[];
}

const mediaVersionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  model: z.string(),
  channel: z.string().nullable(),
  params: z.record(z.string(), z.string()).nullable().catch(null),
  status: z.enum(['queued', 'generating', 'done', 'failed', 'cancelled']).catch('generating'),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  referenceVersionIds: z.array(z.string()).default([]),
});
const mediaListSchema = z.array(
  z.object({
    id: z.string(),
    type: z.enum(['image', 'video', 'audio', 'voice']).catch('image'),
    createdAt: z.string(),
    versions: z.array(mediaVersionSchema),
  }),
);

/** 会话下全部生成位（Web 后端按 desktop:<会话 id> 记账）；卡片状态的唯一数据源 */
export async function listConversationMedia(conversationId: string): Promise<MediaGeneration[]> {
  return mediaListSchema.parse(await agent.call('media.list', { conversationId }));
}

export async function regenerateMedia(
  generationId: string,
  prompt?: string,
  referenceVersionIds?: string[],
): Promise<{ generationId: string; versionId: string }> {
  return z
    .object({ generationId: z.string(), versionId: z.string() })
    .parse(await agent.call('media.regenerate', { generationId, prompt, referenceVersionIds }));
}

/** 取某版本的二进制：aigc 产物都有 CDN 地址，直接从 CDN 取（桌面端没有本地拼接产物） */
export async function fetchMediaAssetBlob(versionId: string): Promise<Blob> {
  const { url } = await agent.call('media.source', { versionId });
  if (!url) throw new Error('This asset has no downloadable URL');
  const cdn = await fetch(url);
  if (!cdn.ok) throw new Error(`Failed to load asset (${cdn.status})`);
  return cdn.blob();
}

// ——— 技能管理（同 Web 名称；GitHub 安装改为一段兼容 npx skills add 的来源串）———
export type { SkillDetail, SkillInfo } from '../../../shared/rpc';

/** 「更新」重装用：从落库的 source 串（github:owner/repo#path@ref）拼回来源 */
export interface InstallSkillInput {
  repo: string;
  path: string;
  ref?: string;
}

export interface CustomSkillInput {
  description: string;
  body: string;
}

export const listSkills = () => agent.call('skills.list', {});

/** 安装：InstallSkillInput（重装同源）或用户输入的来源 / 命令串 */
export function installSkill(input: InstallSkillInput | string) {
  const source =
    typeof input === 'string'
      ? input
      : `https://github.com/${input.repo}/tree/${input.ref ?? 'main'}/${input.path === '.' ? '' : input.path}`;
  return agent.call('skills.installFromGithub', { source });
}

export const installSkillFromFolder = (folder: string) => agent.call('skills.install', { folder });

export const toggleSkill = (name: string, enabled: boolean) =>
  agent.call('skills.setEnabled', { name, enabled });

export const deleteSkill = (name: string) => agent.call('skills.remove', { name });

export const getSkillDetail = (name: string) => agent.call('skills.get', { name });

export const createCustomSkill = (input: CustomSkillInput & { name: string }) =>
  agent.call('skills.saveCustom', { ...input, mode: 'create' });

export const updateCustomSkill = (name: string, input: CustomSkillInput) =>
  agent.call('skills.saveCustom', { name, ...input, mode: 'edit' });

/** 解析 install 落库的 source 串（github:owner/repo#path@ref），供「更新」按钮重装同源（同 Web） */
export function parseGithubSource(source: string): InstallSkillInput | null {
  const m = /^github:([^#]+)#([^@]+)@(.+)$/.exec(source);
  if (!m) return null;
  return { repo: m[1], path: m[2], ref: m[3] };
}
